import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { BinaryManager } from '../src/main/binaries/BinaryManager'
import { HlsDashEngine } from '../src/main/downloader/HlsDashEngine'
import { parseHlsManifest } from '../src/main/sniffer/ManifestParser'
import type { DownloadTask } from '../src/shared/types'

describe('End-to-End AES-128 Encrypted HLS Download & FFmpeg Muxing (Portable Binaries)', () => {
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

  it('decrypts an AES-128 HLS stream requiring cloned session cookies and muxes valid H.264+AAC MP4', async () => {
    const binaries = new BinaryManager()
    const health = binaries.checkHealth()
    expect(health.binaries.every((b) => b.installed && b.isPortableLocal)).toBe(true)

    const ffmpegPath = binaries.getRequiredPath('ffmpeg')
    const ffprobePath = binaries.getRequiredPath('ffprobe')

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-hls-e2e-'))
    tempDirs.push(tmp)
    const streamDir = path.join(tmp, 'hls-origin')
    fs.mkdirSync(streamDir, { recursive: true })

    // Create AES-128 16-byte key and keyinfo file for FFmpeg HLS muxer
    const aesKey = crypto.randomBytes(16)
    const keyFilePath = path.join(streamDir, 'secret.key')
    fs.writeFileSync(keyFilePath, aesKey)

    const keyInfoPath = path.join(tmp, 'keyinfo.txt')
    fs.writeFileSync(keyInfoPath, `secret.key\n${keyFilePath}\n`, 'utf8')

    const m3u8OriginPath = path.join(streamDir, 'playlist.m3u8')

    // Generate a 4-second synthetic 640x360 H.264 video + 44.1kHz AAC audio AES-128 HLS stream
    execFileSync(
      ffmpegPath,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=4:size=640x360:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-hls_time',
        '1',
        '-hls_key_info_file',
        keyInfoPath,
        '-hls_segment_filename',
        path.join(streamDir, 'seg_%03d.ts'),
        m3u8OriginPath
      ],
      { stdio: 'ignore', windowsHide: true }
    )

    // Protected HTTP server that rejects requests with 403 unless Cookie: sg_session=valid_cookie_99 is passed!
    const REQUIRED_COOKIE = 'sg_session=valid_cookie_99'
    const server = http.createServer((req, res) => {
      const cookie = req.headers.cookie || ''
      if (!cookie.includes(REQUIRED_COOKIE)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        res.end('Forbidden: missing cloned browser session cookie')
        return
      }

      const safeName = path.basename(new URL(req.url || '/', 'http://127.0.0.1').pathname)
      const target = path.join(streamDir, safeName)
      if (!fs.existsSync(target)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200)
      fs.createReadStream(target).pipe(res)
    })

    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port

    const originManifestUrl = `http://127.0.0.1:${port}/playlist.m3u8`
    const rawM3u8 = fs.readFileSync(m3u8OriginPath, 'utf8')

    // Simulate Sniffer zero-re-fetch manifest normalization
    const parsed = parseHlsManifest(rawM3u8, originManifestUrl)
    expect(parsed.isEncryptedAes128).toBe(true)

    const cachedManifestPath = path.join(tmp, 'cached_sniffer.m3u8')
    fs.writeFileSync(cachedManifestPath, parsed.normalizedManifestText, 'utf8')

    const outputMp4Path = path.join(tmp, 'Final_Muxed_Stream.mp4')
    const task: DownloadTask = {
      id: 'e2e-hls-1',
      engine: 'hls_dash',
      status: 'downloading',
      title: 'Encrypted HLS Stream',
      filename: 'Final_Muxed_Stream.mp4',
      savePath: outputMp4Path,
      url: originManifestUrl,
      sourcePageUrl: `http://127.0.0.1:${port}/watch`,
      partition: 'persist:browser',
      requestHeaders: {
        'User-Agent': 'StreamGrabTest/1.0',
        Referer: `http://127.0.0.1:${port}/watch`,
        Cookie: REQUIRED_COOKIE
      },
      localManifestPath: cachedManifestPath,
      baseUrl: `http://127.0.0.1:${port}/`,
      trackSelection: {
        audioOnly: false,
        audioFormat: 'm4a',
        container: 'mp4'
      },
      mediaSignature: 'hls:127.0.0.1/playlist.m3u8',
      totalBytes: 0,
      downloadedBytes: 0,
      speedBps: 0,
      etaSec: 0,
      percent: 0,
      tokenRefreshCount: 0,
      createdAt: Date.now()
    }

    const progressSnapshots: number[] = []
    const engine = new HlsDashEngine(binaries)
    await engine.run(task, 8, (u) => {
      progressSnapshots.push(u.percent)
    })

    // Verify real-time intermediate progress events fired from N_m3u8DL-RE's non-TTY stdout stream!
    expect(progressSnapshots.length).toBeGreaterThan(0)
    expect(progressSnapshots.some((p) => p > 0)).toBe(true)
    expect(fs.existsSync(outputMp4Path)).toBe(true)

    // Probe output MP4 with ffprobe to verify both H.264 video & AAC audio streams muxed cleanly!
    const probeJson = execFileSync(
      ffprobePath,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', outputMp4Path],
      { encoding: 'utf8', windowsHide: true }
    )
    const probeData = JSON.parse(probeJson) as {
      streams: Array<{ codec_name: string; codec_type: string }>
      format: { duration: string }
    }

    const codecs = probeData.streams.map((s) => s.codec_name)
    expect(codecs).toContain('h264')
    expect(codecs).toContain('aac')
    expect(parseFloat(probeData.format.duration)).toBeGreaterThan(3.5)
  })
})
