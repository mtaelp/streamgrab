import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/main/storage/DatabaseService'
import { extractHostname, isDomainInWhitelist } from '../src/main/adblock/WebRequestMultiplexer'

describe('DatabaseService (node:sqlite) & Adblock Whitelist Multiplexer', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    tempDirs.length = 0
  })

  it('persists downloads, byte-range chunks, bookmarks, and excludes Incognito history', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-db-test-'))
    tempDirs.push(tmp)

    const dbPath = path.join(tmp, 'test.db')
    const db = new DatabaseService(dbPath, path.join(tmp, 'downloads'))

    // Settings
    const updatedSettings = db.updateSettings({ maxThreadsPerDownload: 32 })
    expect(updatedSettings.maxThreadsPerDownload).toBe(32)

    // Bookmarks
    const bm = db.addBookmark({ url: 'https://example.com/watch', title: 'Example Stream' })
    expect(db.listBookmarks()).toHaveLength(1)
    expect(bm.title).toBe('Example Stream')

    // History: normal vs Incognito
    db.recordHistoryVisit({
      url: 'https://public.site/video1',
      title: 'Public Video',
      isIncognito: false
    })
    db.recordHistoryVisit({
      url: 'https://secret.site/private-video',
      title: 'Secret Video',
      isIncognito: true
    })

    const hist = db.listHistory()
    expect(hist).toHaveLength(1)
    expect(hist[0].url).toBe('https://public.site/video1')

    // Interrupted Download Recovery & Chunks
    db.upsertDownload({
      id: 'task-1',
      engine: 'direct_range',
      status: 'downloading',
      title: 'Movie',
      filename: 'Movie.mp4',
      savePath: path.join(tmp, 'Movie.mp4'),
      url: 'https://cdn.site/Movie.mp4',
      sourcePageUrl: 'https://site/watch',
      partition: 'persist:browser',
      requestHeaders: {},
      trackSelection: { audioOnly: false, audioFormat: 'm4a', container: 'mp4' },
      mediaSignature: 'direct:cdn.site/Movie.mp4',
      totalBytes: 1000,
      downloadedBytes: 500,
      speedBps: 100,
      etaSec: 5,
      percent: 50,
      tokenRefreshCount: 0,
      createdAt: Date.now()
    })

    db.saveChunks('task-1', [
      {
        taskId: 'task-1',
        chunkIndex: 0,
        startByte: 0,
        currentByte: 250,
        endByte: 499,
        status: 'active'
      },
      {
        taskId: 'task-1',
        chunkIndex: 1,
        startByte: 500,
        currentByte: 750,
        endByte: 999,
        status: 'active'
      }
    ])

    const recovered = db.markInterruptedDownloadsPaused()
    expect(recovered[0].status).toBe('paused')
    expect(db.getChunks('task-1')).toHaveLength(2)

    db.close()
  })

  it('matches domains and subdomains accurately in Adblock Whitelist', () => {
    const whitelist = ['streamtest.org', 'vimeo.com']
    expect(isDomainInWhitelist(extractHostname('https://www.streamtest.org/v/1'), whitelist)).toBe(
      true
    )
    expect(isDomainInWhitelist(extractHostname('https://cdn.sub.vimeo.com/hls.m3u8'), whitelist)).toBe(
      true
    )
    expect(isDomainInWhitelist(extractHostname('https://fakestreamtest.org/ad.js'), whitelist)).toBe(
      false
    )
  })
})
