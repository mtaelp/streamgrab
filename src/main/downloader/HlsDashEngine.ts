import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { DownloadTask } from '@shared/types'
import type { BinaryManager } from '../binaries/BinaryManager'
import { diagLogger } from '../logger/DiagnosticLogger'
import { resolvePortablePaths } from '../portable/PortablePaths'
import { CancelRequestedError, PauseRequestedError, TokenExpiredError } from './Errors'

export interface HlsDashProgressUpdate {
  status?: 'downloading' | 'muxing'
  percent: number
  downloadedBytes: number
  totalBytes: number
  speedBps: number
  etaSec: number
  segmentsDone?: number
  segmentsTotal?: number
}

interface TrackStreamTelemetry {
  seen: boolean
  percent: number
  downloadedBytes: number
  totalBytes: number
  speedBps: number
  etaSec: number
  segmentsDone: number
  segmentsTotal: number
}

function parseSizeOrSpeedToBytes(numStr: string, unitStr: string): number {
  const val = parseFloat(numStr)
  if (!Number.isFinite(val) || val < 0) return 0
  const u = unitStr.toUpperCase()
  if (u.startsWith('G')) return Math.round(val * 1024 * 1024 * 1024)
  if (u.startsWith('M')) return Math.round(val * 1024 * 1024)
  if (u.startsWith('K')) return Math.round(val * 1024)
  return Math.round(val)
}

function parseHmsToSec(hms: string): number {
  const parts = hms.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

/**
 * Splits N_m3u8DL-RE's non-TTY Spectre.Console output stream into individual records.
 * When stdout is redirected without a TTY, Spectre.Console writes Vid/Aud/Sub progress bars
 * and timestamped INFO/WARN logs back-to-back WITHOUT \r or \n newline characters!
 */
export function splitNm3u8StreamTokens(buffer: string): { tokens: string[]; remainder: string } {
  const cleaned = buffer.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
  const parts = cleaned.split(
    /(?=(?:Vid|Aud|Sub)\s|\d{2}:\d{2}:\d{2}\.\d{3}\s+(?:INFO|WARN|ERROR|DEBUG)|[\r\n]+)/
  )
  if (parts.length <= 1) {
    // Flush anyway if buffer grows large, otherwise keep partial trailing token
    if (cleaned.length > 512) {
      return { tokens: [cleaned], remainder: '' }
    }
    return { tokens: [], remainder: cleaned }
  }
  const remainder = parts.pop() || ''
  return {
    tokens: parts.map((p) => p.trim()).filter(Boolean),
    remainder
  }
}

export class HlsDashEngine {
  private binaries: BinaryManager
  private proc: ChildProcess | null = null
  private stopReason: 'pause' | 'cancel' | null = null

  constructor(binaries: BinaryManager) {
    this.binaries = binaries
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
    onProgress: (u: HlsDashProgressUpdate) => void
  ): Promise<void> {
    this.stopReason = null

    const nmPath = this.binaries.getRequiredPath('N_m3u8DL-RE')
    const ffmpegPath = this.binaries.getRequiredPath('ffmpeg')
    const paths = resolvePortablePaths()

    const saveDir = path.dirname(task.savePath)
    fs.mkdirSync(saveDir, { recursive: true })

    const ext = path.extname(task.savePath).replace(/^\./, '').toLowerCase()
    const baseSaveName = path.basename(task.savePath, path.extname(task.savePath))
    const taskTmpDir = path.join(paths.segmentsTempDir, task.id)
    fs.mkdirSync(taskTmpDir, { recursive: true })

    const inputArg =
      task.localManifestPath && fs.existsSync(task.localManifestPath)
        ? task.localManifestPath
        : task.url

    const isAudioOnly = task.trackSelection.audioOnly
    const muxContainer = isAudioOnly ? 'mp4' : task.trackSelection.container || 'mp4'
    const tempMuxBaseName = isAudioOnly ? `${baseSaveName}.__audio_tmp` : baseSaveName

    const buildArgs = (headersToUse: Record<string, string>): string[] => {
      const built: string[] = [
        inputArg,
        '--tmp-dir',
        taskTmpDir,
        '--save-dir',
        saveDir,
        '--save-name',
        tempMuxBaseName,
        '--ffmpeg-binary-path',
        ffmpegPath,
        '--thread-count',
        String(Math.max(4, Math.min(64, threadCount))),
        '--download-retry-count',
        '5',
        '--check-segments-count',
        'false',
        '-mt',
        '--no-ansi-color',
        '--no-log',
        '--disable-update-check',
        '--ui-language',
        'en-US',
        '--auto-subtitle-fix'
      ]

      if (task.baseUrl && inputArg === task.localManifestPath) {
        built.push('--base-url', task.baseUrl)
      }

      for (const [headerName, headerVal] of Object.entries(headersToUse)) {
        if (headerVal) {
          built.push('-H', `${headerName}: ${headerVal}`)
        }
      }

      if (isAudioOnly) {
        built.push('-dv', 'all')
        built.push('-ds', 'all')
        built.push('-sa', task.trackSelection.audioSelector || 'for=best')
      } else {
        built.push('-sv', task.trackSelection.videoSelector || 'for=best')
        built.push('-sa', task.trackSelection.audioSelector || 'for=best')
        if (
          task.trackSelection.subtitleTrackIds &&
          task.trackSelection.subtitleTrackIds.length > 0 &&
          task.trackSelection.subtitleSelector
        ) {
          built.push('-ss', task.trackSelection.subtitleSelector)
        } else {
          built.push('-ds', 'all')
        }
        built.push('-M', `format=${muxContainer}:muxer=ffmpeg`)
      }
      return built
    }

    let latestPercent = task.percent || 0
    let latestDownloadedBytes = task.downloadedBytes || 0
    let latestTotalBytes = task.totalBytes || 0

    const executeSpawnOnce = async (headersToUse: Record<string, string>): Promise<void> => {
      const args = buildArgs(headersToUse)
      diagLogger.log(
        'DOWNLOAD_CMD',
        'spawn_N_m3u8DL-RE',
        {
          taskId: task.id,
          exe: nmPath,
          args,
          trackSelection: task.trackSelection,
          localManifestPath: task.localManifestPath,
          baseUrl: task.baseUrl
        },
        { url: task.url }
      )

      let saw403Count = 0
      const emptyTrack = (): TrackStreamTelemetry => ({
        seen: false,
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSec: 0,
        segmentsDone: 0,
        segmentsTotal: 0
      })
      const vidTrack = emptyTrack()
      const audTrack = emptyTrack()

    await new Promise<void>((resolve, reject) => {
      const child = spawn(nmPath, args, { windowsHide: true })
      this.proc = child

      let stderrTail = ''

      const processToken = (line: string): void => {
        if (!line) return

        const isProgressToken = /^(Vid|Aud|Sub)\s/.test(line) && line.includes('%')
        if (!isProgressToken) {
          diagLogger.log('DOWNLOAD_OUT', 'nm3u8_line', { taskId: task.id, line })
        }

        if (/403\s*Forbidden|HTTP\s*403|status code.*403|401\s*Unauthorized/i.test(line)) {
          saw403Count += 1
        }

        if (/Muxing|Merging.*ffmpeg|Calling\s+ffmpeg/i.test(line)) {
          onProgress({
            status: 'muxing',
            percent: Math.max(98.5, latestPercent),
            downloadedBytes: latestDownloadedBytes,
            totalBytes: latestTotalBytes,
            speedBps: 0,
            etaSec: 1
          })
          return
        }

        if (!isProgressToken) return

        const kind = line.slice(0, 3) as 'Vid' | 'Aud' | 'Sub'
        if (kind === 'Sub') return

        const segMatch = /(\d+)\/(\d+)\s+(\d+(?:\.\d+)?)%/.exec(line)
        const pctMatch = /(\d+(?:\.\d+)?)%/.exec(line)
        if (!pctMatch) return

        const target = kind === 'Vid' ? vidTrack : audTrack
        target.seen = true
        target.percent = Math.min(100, parseFloat(pctMatch[1]))

        if (segMatch) {
          target.segmentsDone = Number(segMatch[1])
          target.segmentsTotal = Number(segMatch[2])
        }

        const sizePairMatch =
          /(\d+(?:\.\d+)?)\s*([KMGT]?i?B)\s*\/\s*(\d+(?:\.\d+)?)\s*([KMGT]?i?B)/i.exec(line)
        if (sizePairMatch) {
          target.downloadedBytes = parseSizeOrSpeedToBytes(sizePairMatch[1], sizePairMatch[2])
          target.totalBytes = parseSizeOrSpeedToBytes(sizePairMatch[3], sizePairMatch[4])
        } else {
          const singleSizeMatch = /%\s+(\d+(?:\.\d+)?)\s*([KMGT]?i?B)(?!\s*(?:ps|\/s|\/))/i.exec(
            line
          )
          if (singleSizeMatch) {
            target.downloadedBytes = parseSizeOrSpeedToBytes(singleSizeMatch[1], singleSizeMatch[2])
            if (target.percent > 1) {
              target.totalBytes = Math.round(target.downloadedBytes / (target.percent / 100))
            }
          }
        }

        const speedMatch = /(?<!-)(\d+(?:\.\d+)?)\s*([KMGT]?i?B)(?:ps|\/s)/i.exec(line)
        target.speedBps = speedMatch
          ? parseSizeOrSpeedToBytes(speedMatch[1], speedMatch[2])
          : 0

        const etaMatch = /(\d{2}:\d{2}:\d{2})/.exec(line)
        target.etaSec = etaMatch ? parseHmsToSec(etaMatch[1]) : 0

        const combinedDl = vidTrack.downloadedBytes + audTrack.downloadedBytes
        const combinedTot =
          vidTrack.totalBytes + audTrack.totalBytes || task.totalBytes || 0
        const combinedSegDone = vidTrack.segmentsDone + audTrack.segmentsDone
        const combinedSegTotal = vidTrack.segmentsTotal + audTrack.segmentsTotal
        const combinedSpeed = vidTrack.speedBps + audTrack.speedBps

        let combinedPct: number
        if (vidTrack.seen && vidTrack.segmentsTotal > 0) {
          // Weight primarily by video segments (92%) + audio segments (8%) for rock-steady progress
          const vPct = (vidTrack.segmentsDone / vidTrack.segmentsTotal) * 100
          const aPct =
            audTrack.seen && audTrack.segmentsTotal > 0
              ? (audTrack.segmentsDone / audTrack.segmentsTotal) * 100
              : vPct
          combinedPct = audTrack.seen ? vPct * 0.92 + aPct * 0.08 : vPct
        } else if (combinedTot > 0 && combinedDl > 0) {
          combinedPct = (combinedDl / combinedTot) * 100
        } else if (vidTrack.seen) {
          combinedPct = vidTrack.percent
        } else {
          combinedPct = audTrack.percent
        }

        latestPercent = Math.max(latestPercent, Math.min(99.5, combinedPct))
        if (combinedDl > 0) latestDownloadedBytes = combinedDl
        if (combinedTot > 0) latestTotalBytes = combinedTot

        // Compute realistic ETA from Video's ETA or remaining bytes/speed (never show Audio's tiny 1m ETA while 3GB Video is still at 7%!)
        let combinedEta = vidTrack.etaSec
        if (combinedEta <= 0 && combinedSpeed > 0 && latestTotalBytes > latestDownloadedBytes) {
          combinedEta = Math.round((latestTotalBytes - latestDownloadedBytes) / combinedSpeed)
        } else if (combinedEta <= 0 && !vidTrack.seen) {
          combinedEta = audTrack.etaSec
        }

        onProgress({
          status: 'downloading',
          percent: latestPercent,
          downloadedBytes: latestDownloadedBytes,
          totalBytes: latestTotalBytes,
          speedBps: combinedSpeed,
          etaSec: combinedEta,
          segmentsDone: combinedSegTotal > 0 ? combinedSegDone : undefined,
          segmentsTotal: combinedSegTotal > 0 ? combinedSegTotal : undefined
        })
      }

      let stdoutBuf = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8')
        const { tokens, remainder } = splitNm3u8StreamTokens(stdoutBuf)
        stdoutBuf = remainder
        for (const tok of tokens) processToken(tok)
      })

      let stderrBuf = ''
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderrTail = (stderrTail + text).slice(-2000)
        stderrBuf += text
        const { tokens, remainder } = splitNm3u8StreamTokens(stderrBuf)
        stderrBuf = remainder
        for (const tok of tokens) processToken(tok)
      })

      child.on('error', (err) => {
        this.proc = null
        reject(err)
      })

      child.on('close', (code) => {
        if (stdoutBuf.trim()) processToken(stdoutBuf.trim())
        if (stderrBuf.trim()) processToken(stderrBuf.trim())
        this.proc = null

        if (this.stopReason === 'pause') {
          reject(new PauseRequestedError())
          return
        }
        if (this.stopReason === 'cancel') {
          fs.rmSync(taskTmpDir, { recursive: true, force: true })
          reject(new CancelRequestedError())
          return
        }
        if (code !== 0) {
          if (saw403Count >= 2) {
            reject(new TokenExpiredError(403))
          } else {
            reject(new Error(stderrTail.trim() || `N_m3u8DL-RE exited with code ${code}`))
          }
          return
        }
        resolve()
      })
    })
    }

    try {
      await executeSpawnOnce(task.requestHeaders)
    } catch (firstErr) {
      // Safety net: if a CDN (like video.twimg.com) rejects Referer/Origin at 0% with 403,
      // immediately retry once with Referer & Origin stripped (no-referrer mode) before giving up!
      const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      const hasRefOrOrigin = Boolean(task.requestHeaders.Referer || task.requestHeaders.Origin)
      if (
        !this.stopReason &&
        latestPercent < 1 &&
        hasRefOrOrigin &&
        (firstErr instanceof TokenExpiredError || /403|401|Unauthorized|Forbidden/i.test(errMsg))
      ) {
        diagLogger.log('DOWNLOAD_CMD', 'retry_without_referer_origin_on_403', {
          taskId: task.id,
          originalReferer: task.requestHeaders.Referer
        })
        const strippedHeaders = { ...task.requestHeaders }
        delete strippedHeaders.Referer
        delete strippedHeaders.Origin
        await executeSpawnOnce(strippedHeaders)
      } else {
        throw firstErr
      }
    }

    if (isAudioOnly) {
      onProgress({
        status: 'muxing',
        percent: 99,
        downloadedBytes: latestDownloadedBytes,
        totalBytes: latestTotalBytes,
        speedBps: 0,
        etaSec: 1
      })

      const candidates = fs
        .readdirSync(saveDir)
        .filter((f) => f.startsWith(tempMuxBaseName))
        .map((f) => path.join(saveDir, f))

      if (candidates.length === 0) {
        throw new Error('Audio stream finished downloading, but output track was not found')
      }

      const rawAudioPath = candidates[0]
      const ffmpegArgs =
        ext === 'mp3'
          ? [
              '-y',
              '-i',
              rawAudioPath,
              '-vn',
              '-codec:a',
              'libmp3lame',
              '-qscale:a',
              '2',
              task.savePath
            ]
          : ['-y', '-i', rawAudioPath, '-vn', '-c:a', 'copy', task.savePath]

      await new Promise<void>((resolve, reject) => {
        const muxProc = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true })
        muxProc.on('error', reject)
        muxProc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`FFmpeg audio packaging exited with code ${code}`))
        })
      })

      for (const c of candidates) {
        if (path.resolve(c) !== path.resolve(task.savePath)) {
          await fs.promises.rm(c, { force: true }).catch(() => {})
        }
      }
    }

    await fs.promises.rm(taskTmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
