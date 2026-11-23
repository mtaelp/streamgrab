import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { DownloadTask } from '@shared/types'
import type { BinaryManager } from '../binaries/BinaryManager'
import type { SessionManager } from '../browser/SessionManager'
import { CookieExporter } from '../sniffer/CookieExporter'
import { CancelRequestedError, PauseRequestedError } from './Errors'

export interface YtDlpProgressUpdate {
  status: 'downloading' | 'muxing'
  percent: number
  downloadedBytes: number
  totalBytes: number
  speedBps: number
  etaSec: number
}

export class YtDlpEngine {
  private binaries: BinaryManager
  private sessionManager: SessionManager
  private proc: ChildProcess | null = null
  private stopReason: 'pause' | 'cancel' | null = null

  constructor(binaries: BinaryManager, sessionManager: SessionManager) {
    this.binaries = binaries
    this.sessionManager = sessionManager
  }

  public pause(): void {
    this.stopReason = 'pause'
    this.proc?.kill()
  }

  public cancel(): void {
    this.stopReason = 'cancel'
    this.proc?.kill()
  }

  public async run(
    task: DownloadTask,
    threadCount: number,
    onProgress: (u: YtDlpProgressUpdate) => void
  ): Promise<void> {
    this.stopReason = null

    const ytdlpPath = this.binaries.getRequiredPath('yt-dlp')
    const ffmpegPath = this.binaries.getRequiredPath('ffmpeg')
    const sess = this.sessionManager.getSessionByPartition(task.partition)

    const saveDir = path.dirname(task.savePath)
    fs.mkdirSync(saveDir, { recursive: true })

    const cookieJarPath = await CookieExporter.exportNetscapeCookieJar(sess, [
      task.url,
      task.sourcePageUrl
    ])

    const args: string[] = [
      '--no-playlist',
      '--continue',
      '--newline',
      '--no-warnings',
      '--cookies',
      cookieJarPath,
      '--ffmpeg-location',
      path.dirname(ffmpegPath),
      '--concurrent-fragments',
      String(Math.max(1, Math.min(32, threadCount))),
      '--progress-template',
      'download:__SGPROG__|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s'
    ]

    if (task.requestHeaders['User-Agent']) {
      args.push('--user-agent', task.requestHeaders['User-Agent'])
    }
    if (task.requestHeaders.Referer) {
      args.push('--referer', task.requestHeaders.Referer)
    }

    if (task.trackSelection.audioOnly) {
      const fmt = task.trackSelection.audioFormat || 'm4a'
      const outTemplate = task.savePath.replace(/\.[a-z0-9]+$/i, '.%(ext)s')
      args.push('-f', task.trackSelection.audioSelector || 'bestaudio/best')
      args.push('-x', '--audio-format', fmt, '--audio-quality', '0')
      args.push('-o', outTemplate)
    } else {
      const container = task.trackSelection.container || 'mp4'
      const videoSel = task.trackSelection.videoSelector || 'bestvideo+bestaudio/best'
      args.push('-f', videoSel)
      args.push('--merge-output-format', container)

      if (
        task.trackSelection.subtitleTrackIds &&
        task.trackSelection.subtitleTrackIds.length > 0 &&
        task.trackSelection.subtitleSelector
      ) {
        args.push('--write-subs', '--embed-subs', '--sub-langs', task.trackSelection.subtitleSelector)
      }

      args.push('-o', task.savePath)
    }

    args.push(task.url)

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ytdlpPath, args, { windowsHide: true })
        this.proc = child

        let stderrTail = ''

        const handleLine = (line: string): void => {
          const trimmed = line.trim()
          if (!trimmed) return

          if (trimmed.includes('[Merger]') || trimmed.includes('[ExtractAudio]')) {
            onProgress({
              status: 'muxing',
              percent: 99,
              downloadedBytes: task.downloadedBytes,
              totalBytes: task.totalBytes,
              speedBps: 0,
              etaSec: 1
            })
            return
          }

          const idx = trimmed.indexOf('__SGPROG__|')
          if (idx >= 0) {
            const parts = trimmed.slice(idx).split('|')
            const pct = parseFloat((parts[1] || '').replace('%', '').trim())
            const dlBytes = Number(parts[2]) || 0
            const totalBytes = Number(parts[3]) || Number(parts[4]) || 0
            const speed = Number(parts[5]) || 0
            const eta = Number(parts[6]) || 0

            onProgress({
              status: 'downloading',
              percent: Number.isFinite(pct) ? Math.min(99.5, pct) : task.percent,
              downloadedBytes: dlBytes,
              totalBytes,
              speedBps: Math.round(speed),
              etaSec: Math.round(eta)
            })
          }
        }

        let buf = ''
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8')
          const lines = buf.split(/[\r\n]+/)
          buf = lines.pop() || ''
          for (const l of lines) handleLine(l)
        })

        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stderrTail = (stderrTail + text).slice(-2000)
          for (const l of text.split(/[\r\n]+/)) handleLine(l)
        })

        child.on('error', (err) => {
          this.proc = null
          reject(err)
        })

        child.on('close', (code) => {
          this.proc = null
          if (this.stopReason === 'pause') {
            reject(new PauseRequestedError())
            return
          }
          if (this.stopReason === 'cancel') {
            // Remove partial yt-dlp artifacts
            const prefix = path.basename(task.savePath, path.extname(task.savePath))
            for (const f of fs.readdirSync(saveDir)) {
              if (f.startsWith(prefix) && (f.endsWith('.part') || f.endsWith('.ytdl'))) {
                fs.rmSync(path.join(saveDir, f), { force: true })
              }
            }
            reject(new CancelRequestedError())
            return
          }
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(stderrTail.trim() || `yt-dlp exited with code ${code}`))
          }
        })
      })
    } finally {
      await fs.promises.rm(cookieJarPath, { force: true }).catch(() => {})
    }
  }
}
