import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { shell } from 'electron'
import type {
  DetectedMedia,
  DownloadEngineType,
  DownloadTask,
  TrackSelection
} from '@shared/types'
import type { BinaryManager } from '../binaries/BinaryManager'
import type {
  InterceptedStandardDownload,
  SessionManager
} from '../browser/SessionManager'
import type { HeadlessSniffer } from '../sniffer/HeadlessSniffer'
import { computeMediaSignature } from '../sniffer/SnifferManager'
import type { DatabaseService } from '../storage/DatabaseService'
import { DirectRangeEngine } from './DirectRangeEngine'
import { CancelRequestedError, PauseRequestedError, TokenExpiredError } from './Errors'
import { HlsDashEngine } from './HlsDashEngine'
import { YtDlpEngine } from './YtDlpEngine'

interface RunningWorkerHandle {
  pause: () => void
  cancel: () => void
}

export function sanitizeWindowsFilename(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim()
  return (cleaned || 'stream_download').slice(0, 160)
}

export function ensureUniqueFilePath(dir: string, desiredFilename: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const ext = path.extname(desiredFilename)
  const stem = path.basename(desiredFilename, ext)
  let candidate = path.join(dir, desiredFilename)
  let counter = 1
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`)) {
    candidate = path.join(dir, `${stem} (${counter})${ext}`)
    counter += 1
  }
  return candidate
}

export class DownloadOrchestrator {
  private db: DatabaseService
  private binaries: BinaryManager
  private sessionManager: SessionManager
  private headlessSniffer: HeadlessSniffer
  private onTasksUpdated?: (tasks: DownloadTask[]) => void

  private tasks = new Map<string, DownloadTask>()
  private activeWorkers = new Map<string, RunningWorkerHandle>()

  constructor(
    db: DatabaseService,
    binaries: BinaryManager,
    sessionManager: SessionManager,
    headlessSniffer: HeadlessSniffer,
    onTasksUpdated?: (tasks: DownloadTask[]) => void
  ) {
    this.db = db
    this.binaries = binaries
    this.sessionManager = sessionManager
    this.headlessSniffer = headlessSniffer
    this.onTasksUpdated = onTasksUpdated

    for (const restored of this.db.markInterruptedDownloadsPaused()) {
      this.tasks.set(restored.id, restored)
    }
  }

  public getAllTasks(): DownloadTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => ({ ...t }))
  }

  public startFromDetectedMedia(
    media: DetectedMedia,
    selection: TrackSelection
  ): DownloadTask {
    if (media.isDrmProtected) {
      throw new Error(
        `This stream is protected by hardware DRM (${media.drmSystem || 'Widevine/PlayReady'}) and cannot be decrypted outside the browser player.`
      )
    }

    const settings = this.db.getSettings()
    let engine: DownloadEngineType
    if (media.type === 'hls' || media.type === 'dash') {
      engine = 'hls_dash'
    } else if (media.type === 'ytdlp') {
      engine = 'ytdlp'
    } else {
      engine = 'direct_range'
    }

    let ext: string
    if (selection.audioOnly) {
      ext = selection.audioFormat || 'm4a'
    } else if (engine === 'direct_range') {
      ext = media.containerHint || 'mp4'
    } else {
      ext = selection.container || 'mp4'
    }

    const baseTitle = sanitizeWindowsFilename(selection.customFilename || media.title)
    const cleanStem = baseTitle.replace(/\.(mp4|mkv|m4a|mp3|webm)$/i, '')
    const desiredName = `${cleanStem}.${ext}`
    const savePath = ensureUniqueFilePath(settings.downloadDir, desiredName)

    const selectedVideo = media.videoTracks.find((v) => v.id === selection.videoTrackId) || media.videoTracks[0]
    const selectedAudios = media.audioTracks.filter((a) =>
      selection.audioTrackIds?.includes(a.id)
    )
    const selectedSubs = media.subtitleTracks.filter((s) =>
      selection.subtitleTrackIds?.includes(s.id)
    )

    const enrichedSelection: TrackSelection = {
      ...selection,
      videoSelector: selection.videoSelector || selectedVideo?.selector,
      audioSelector:
        selection.audioSelector ||
        (selectedAudios.length > 0
          ? selectedAudios.map((a) => a.selector).filter(Boolean).join('|')
          : undefined),
      subtitleSelector:
        selection.subtitleSelector ||
        (selectedSubs.length > 0
          ? selectedSubs
              .map((s) => s.language || s.selector)
              .filter(Boolean)
              .join(',')
          : undefined)
    }

    const task: DownloadTask = {
      id: crypto.randomUUID(),
      mediaId: media.id,
      engine,
      status: 'queued',
      title: media.title,
      filename: path.basename(savePath),
      savePath,
      url: media.url,
      sourcePageUrl: media.sourcePageUrl,
      partition: media.partition,
      requestHeaders: { ...media.requestHeaders },
      localManifestPath: media.localManifestPath,
      baseUrl: media.baseUrl,
      trackSelection: enrichedSelection,
      mediaSignature: media.mediaSignature,
      totalBytes: selectedVideo?.estimatedBytes || media.sizeBytes || 0,
      downloadedBytes: 0,
      speedBps: 0,
      etaSec: 0,
      percent: 0,
      tokenRefreshCount: 0,
      createdAt: Date.now()
    }

    this.tasks.set(task.id, task)
    this.db.upsertDownload(task)
    this.broadcastImmediate()
    this.pumpQueue()
    return { ...task }
  }

  public startFromStandardBrowserDownload(info: InterceptedStandardDownload): DownloadTask {
    const settings = this.db.getSettings()
    const cleanFilename = sanitizeWindowsFilename(info.filename)
    const savePath = ensureUniqueFilePath(settings.downloadDir, cleanFilename)

    const task: DownloadTask = {
      id: crypto.randomUUID(),
      engine: 'direct_range',
      status: 'queued',
      title: path.basename(savePath),
      filename: path.basename(savePath),
      savePath,
      url: info.url,
      sourcePageUrl: info.sourcePageUrl,
      partition: info.partition,
      requestHeaders: info.requestHeaders,
      trackSelection: {
        audioOnly: false,
        audioFormat: 'm4a',
        container: 'mp4'
      },
      mediaSignature: computeMediaSignature('direct', info.url),
      totalBytes: info.totalBytes || 0,
      downloadedBytes: 0,
      speedBps: 0,
      etaSec: 0,
      percent: 0,
      tokenRefreshCount: 0,
      createdAt: Date.now()
    }

    this.tasks.set(task.id, task)
    this.db.upsertDownload(task)
    this.broadcastImmediate()
    this.pumpQueue()
    return { ...task }
  }

  public pauseTask(taskId: string): void {
    const worker = this.activeWorkers.get(taskId)
    if (worker) {
      worker.pause()
      return
    }
    const task = this.tasks.get(taskId)
    if (task && task.status === 'queued') {
      task.status = 'paused'
      this.db.upsertDownload(task)
      this.broadcastImmediate()
    }
  }

  public resumeTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (task.status === 'paused' || task.status === 'failed') {
      task.status = 'queued'
      task.error = undefined
      this.db.upsertDownload(task)
      this.broadcastImmediate()
      this.pumpQueue()
    }
  }

  public cancelTask(taskId: string): void {
    const worker = this.activeWorkers.get(taskId)
    if (worker) {
      worker.cancel()
      return
    }
    const task = this.tasks.get(taskId)
    if (task) {
      task.status = 'cancelled'
      task.speedBps = 0
      task.etaSec = 0
      this.db.upsertDownload(task)
      this.db.saveChunks(task.id, [])
      void fs.promises.rm(`${task.savePath}.part`, { force: true }).catch(() => {})
      this.broadcastImmediate()
    }
  }

  public deleteTask(taskId: string, deleteFileOnDisk = false): void {
    this.cancelTask(taskId)
    const task = this.tasks.get(taskId)
    if (task && deleteFileOnDisk) {
      void fs.promises.rm(task.savePath, { force: true }).catch(() => {})
      void fs.promises.rm(`${task.savePath}.part`, { force: true }).catch(() => {})
    }
    this.tasks.delete(taskId)
    this.db.deleteDownload(taskId)
    this.broadcastImmediate()
  }

  public clearCompleted(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'completed' || task.status === 'cancelled') {
        this.tasks.delete(id)
      }
    }
    this.db.clearCompletedDownloads()
    this.broadcastImmediate()
  }

  public async openFile(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (task && fs.existsSync(task.savePath)) {
      await shell.openPath(task.savePath)
    }
  }

  public showInFolder(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    if (fs.existsSync(task.savePath)) {
      shell.showItemInFolder(task.savePath)
    } else {
      void shell.openPath(path.dirname(task.savePath))
    }
  }

  private pumpQueue(): void {
    const settings = this.db.getSettings()
    const maxConcurrent = Math.max(1, settings.maxConcurrentDownloads)
    if (this.activeWorkers.size >= maxConcurrent) return

    const queued = Array.from(this.tasks.values())
      .filter((t) => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)

    for (const nextTask of queued) {
      if (this.activeWorkers.size >= maxConcurrent) break
      void this.executeTaskWithTokenRecovery(nextTask)
    }
  }

  private async executeTaskWithTokenRecovery(task: DownloadTask): Promise<void> {
    const settings = this.db.getSettings()
    const threadCount = Math.max(1, Math.min(64, settings.maxThreadsPerDownload))

    while (true) {
      task.status = 'downloading'
      task.error = undefined
      this.db.upsertDownload(task)
      this.broadcastImmediate()

      try {
        if (task.engine === 'direct_range') {
          const engine = new DirectRangeEngine(this.db)
          this.activeWorkers.set(task.id, engine)
          await engine.run(task, threadCount, (u) => {
            task.downloadedBytes = u.downloadedBytes
            task.totalBytes = u.totalBytes || task.totalBytes
            task.speedBps = u.speedBps
            task.etaSec = u.etaSec
            task.percent = u.percent
            task.activeThreads = u.activeThreads
            this.broadcastThrottled()
          })
        } else if (task.engine === 'hls_dash') {
          const engine = new HlsDashEngine(this.binaries)
          this.activeWorkers.set(task.id, engine)
          task.activeThreads = threadCount
          await engine.run(task, threadCount, (u) => {
            if (u.status) task.status = u.status
            task.percent = u.percent
            if (u.downloadedBytes > 0) task.downloadedBytes = u.downloadedBytes
            if (u.totalBytes > 0) task.totalBytes = u.totalBytes
            task.speedBps = u.speedBps
            task.etaSec = u.etaSec
            if (u.segmentsDone !== undefined) task.segmentsDone = u.segmentsDone
            if (u.segmentsTotal !== undefined) task.segmentsTotal = u.segmentsTotal
            this.broadcastThrottled()
          })
        } else {
          const engine = new YtDlpEngine(this.binaries, this.sessionManager)
          this.activeWorkers.set(task.id, engine)
          await engine.run(task, threadCount, (u) => {
            task.status = u.status
            task.percent = u.percent
            if (u.downloadedBytes > 0) task.downloadedBytes = u.downloadedBytes
            if (u.totalBytes > 0) task.totalBytes = u.totalBytes
            task.speedBps = u.speedBps
            task.etaSec = u.etaSec
            this.broadcastThrottled()
          })
        }

        // Verify final file size on disk
        if (fs.existsSync(task.savePath)) {
          const stat = fs.statSync(task.savePath)
          task.totalBytes = stat.size
          task.downloadedBytes = stat.size
        }

        task.status = 'completed'
        task.percent = 100
        task.speedBps = 0
        task.etaSec = 0
        task.activeThreads = 0
        task.completedAt = Date.now()
        this.activeWorkers.delete(task.id)
        this.db.upsertDownload(task)
        this.broadcastImmediate()
        this.pumpQueue()
        return
      } catch (err) {
        this.activeWorkers.delete(task.id)

        if (err instanceof PauseRequestedError) {
          task.status = 'paused'
          task.speedBps = 0
          task.etaSec = 0
          task.activeThreads = 0
          this.db.upsertDownload(task)
          this.broadcastImmediate()
          this.pumpQueue()
          return
        }

        if (err instanceof CancelRequestedError) {
          task.status = 'cancelled'
          task.speedBps = 0
          task.etaSec = 0
          task.activeThreads = 0
          this.db.upsertDownload(task)
          this.broadcastImmediate()
          this.pumpQueue()
          return
        }

        if (
          err instanceof TokenExpiredError &&
          this.db.getSettings().autoRefreshExpiredTokens &&
          task.tokenRefreshCount < 3 &&
          task.sourcePageUrl.startsWith('http')
        ) {
          task.status = 'refreshing_token'
          task.speedBps = 0
          task.error = `HTTP ${err.statusCode} token expired — re-authenticating via background tab...`
          this.db.upsertDownload(task)
          this.broadcastImmediate()

          const targetType =
            task.engine === 'direct_range'
              ? 'direct'
              : task.localManifestPath?.endsWith('.mpd')
                ? 'dash'
                : 'hls'

          const refreshed = await this.headlessSniffer.refreshStreamCredentials({
            sourcePageUrl: task.sourcePageUrl,
            partition: task.partition,
            targetSignature: task.mediaSignature,
            targetType
          })

          if (refreshed) {
            task.url = refreshed.url
            task.requestHeaders = { ...refreshed.requestHeaders }
            if (refreshed.localManifestPath) task.localManifestPath = refreshed.localManifestPath
            if (refreshed.baseUrl) task.baseUrl = refreshed.baseUrl
            task.tokenRefreshCount += 1
            task.error = undefined
            this.db.upsertDownload(task)
            continue // Re-enter loop seamlessly resuming from saved byte cursors / --tmp-dir segments!
          }
        }

        task.status = 'failed'
        task.speedBps = 0
        task.etaSec = 0
        task.activeThreads = 0
        task.error = err instanceof Error ? err.message : String(err)
        this.db.upsertDownload(task)
        this.broadcastImmediate()
        this.pumpQueue()
        return
      }
    }
  }

  private throttleTimer: NodeJS.Timeout | null = null
  private broadcastThrottled(): void {
    if (this.throttleTimer) return
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      this.onTasksUpdated?.(this.getAllTasks())
    }, 220)
  }

  private broadcastImmediate(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    this.onTasksUpdated?.(this.getAllTasks())
  }
}
