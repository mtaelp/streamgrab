import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/main/storage/DatabaseService'
import { DirectRangeEngine } from '../src/main/downloader/DirectRangeEngine'
import { TokenExpiredError } from '../src/main/downloader/Errors'
import type { DownloadTask } from '../src/shared/types'

describe('DirectRangeEngine (Multi-Threaded HTTP Range + 403 Token Recovery)', () => {
  const tempDirs: string[] = []
  const servers: http.Server[] = []

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
    servers.length = 0
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  it('downloads across 8 parallel workers with work-stealing, recovers from 403 expiry, and matches SHA-256', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-range-test-'))
    tempDirs.push(tmp)

    // Deterministic 5 MB binary buffer
    const payloadSize = 5 * 1024 * 1024
    const payload = crypto.randomBytes(payloadSize)
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex')

    let activeValidToken = 'token_v1'
    let rangeRequestsServed = 0
    let expiredTriggered = false

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
      const tok = reqUrl.searchParams.get('token')

      if (tok !== activeValidToken) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Expired token')
        return
      }

      const rangeHeader = req.headers.range
      if (!rangeHeader) {
        res.writeHead(200, {
          'Content-Length': payloadSize,
          'Accept-Ranges': 'bytes'
        })
        res.end(payload)
        return
      }

      rangeRequestsServed += 1
      // Simulate token expiring mid-download after several range chunks start!
      if (!expiredTriggered && rangeRequestsServed === 4) {
        expiredTriggered = true
        activeValidToken = 'token_v2'
        res.writeHead(403)
        res.end('Token rotated mid-flight')
        return
      }

      const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader)
      if (!match) {
        res.writeHead(416)
        res.end()
        return
      }

      const start = Number(match[1])
      const end = Math.min(payloadSize - 1, Number(match[2]))
      const slice = payload.subarray(start, end + 1)

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payloadSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': slice.byteLength
      })
      res.end(slice)
    })

    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port

    const db = new DatabaseService(path.join(tmp, 'range.db'), tmp)
    const savePath = path.join(tmp, 'reconstructed.mp4')

    const task: DownloadTask = {
      id: 'range-task-1',
      engine: 'direct_range',
      status: 'downloading',
      title: 'Test Video',
      filename: 'reconstructed.mp4',
      savePath,
      url: `http://127.0.0.1:${port}/video.mp4?token=token_v1`,
      sourcePageUrl: `http://127.0.0.1:${port}/watch`,
      partition: 'persist:browser',
      requestHeaders: { 'User-Agent': 'StreamGrabTest/1.0' },
      trackSelection: { audioOnly: false, audioFormat: 'm4a', container: 'mp4' },
      mediaSignature: 'direct:127.0.0.1/video.mp4',
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      etaSec: 0,
      percent: 0,
      tokenRefreshCount: 0,
      createdAt: Date.now()
    }
    db.upsertDownload(task)

    const engine1 = new DirectRangeEngine(db)
    await expect(engine1.run(task, 8, () => {})).rejects.toBeInstanceOf(TokenExpiredError)

    // Verify partial progress was persisted in SQLite chunks
    const savedChunks = db.getChunks(task.id)
    expect(savedChunks.length).toBeGreaterThan(0)

    // Update task with refreshed token_v2 and resume seamlessly!
    task.url = `http://127.0.0.1:${port}/video.mp4?token=token_v2`
    const engine2 = new DirectRangeEngine(db)
    await engine2.run(task, 8, () => {})

    expect(fs.existsSync(savePath)).toBe(true)
    const actualSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(savePath))
      .digest('hex')
    expect(actualSha256).toBe(expectedSha256)

    db.close()
  })
})
