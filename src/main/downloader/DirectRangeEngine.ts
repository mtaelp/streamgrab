import fs from 'node:fs'
import path from 'node:path'
import type { DownloadChunkRecord, DownloadTask } from '@shared/types'
import type { DatabaseService } from '../storage/DatabaseService'
import { runtimeFetch } from '../portable/RuntimeFetch'
import { CancelRequestedError, PauseRequestedError, TokenExpiredError } from './Errors'

export interface DirectProgressUpdate {
  downloadedBytes: number
  totalBytes: number
  speedBps: number
  etaSec: number
  percent: number
  activeThreads: number
}

const MIN_SPLIT_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB minimum remaining to steal/split a chunk

export class DirectRangeEngine {
  private db: DatabaseService
  private abortController: AbortController | null = null
  private stopReason: 'pause' | 'cancel' | null = null

  constructor(db: DatabaseService) {
    this.db = db
  }

  public pause(): void {
    this.stopReason = 'pause'
    this.abortController?.abort()
  }

  public cancel(): void {
    this.stopReason = 'cancel'
    this.abortController?.abort()
  }

  public async run(
    task: DownloadTask,
    threadCount: number,
    onProgress: (update: DirectProgressUpdate) => void
  ): Promise<void> {
    this.stopReason = null
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    const partPath = `${task.savePath}.part`
    fs.mkdirSync(path.dirname(task.savePath), { recursive: true })

    // 1. Probe target URL for size & Range support
    const probe = await this.probeRemoteFile(task.url, task.requestHeaders, signal)

    // 2. Load existing resume chunks or initialize fresh byte ranges
    let chunks = this.db.getChunks(task.id)
    const canMultiThread = probe.supportsRanges && probe.totalBytes >= 1024 * 1024 && threadCount > 1

    if (!canMultiThread) {
      await this.runSingleStream(task, partPath, probe.totalBytes, signal, onProgress)
      await fs.promises.rename(partPath, task.savePath)
      this.db.saveChunks(task.id, [])
      return
    }

    const totalBytes = probe.totalBytes
    if (
      chunks.length === 0 ||
      chunks[chunks.length - 1].endByte !== totalBytes - 1 ||
      !fs.existsSync(partPath)
    ) {
      const numWorkers = Math.min(
        Math.max(1, threadCount),
        Math.max(1, Math.floor(totalBytes / (512 * 1024)))
      )
      chunks = this.createInitialChunks(task.id, totalBytes, numWorkers)
      this.db.saveChunks(task.id, chunks)

      // Pre-create sparse .part file of exact target length
      const fhInit = await fs.promises.open(partPath, 'w')
      await fhInit.truncate(totalBytes)
      await fhInit.close()
    } else {
      // Reset any 'active' chunks from prior interrupted session back to 'pending'
      for (const c of chunks) {
        if (c.status === 'active') {
          c.status = c.currentByte > c.endByte ? 'completed' : 'pending'
        }
      }
      this.db.saveChunks(task.id, chunks)
    }

    const fileHandle = await fs.promises.open(partPath, 'r+')
    let activeWorkers = 0
    let lastTickTime = Date.now()
    let lastTickBytes = this.sumDownloadedBytes(chunks)
    let smoothedSpeed = 0

    const progressTimer = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(0.05, (now - lastTickTime) / 1000)
      const currentBytes = this.sumDownloadedBytes(chunks)
      const instantSpeed = Math.max(0, (currentBytes - lastTickBytes) / dt)
      smoothedSpeed = smoothedSpeed === 0 ? instantSpeed : smoothedSpeed * 0.65 + instantSpeed * 0.35

      lastTickTime = now
      lastTickBytes = currentBytes

      const remaining = Math.max(0, totalBytes - currentBytes)
      const etaSec = smoothedSpeed > 0 ? Math.round(remaining / smoothedSpeed) : 0
      const percent = totalBytes > 0 ? Math.min(99.9, (currentBytes / totalBytes) * 100) : 0

      // Persist chunk byte cursors periodically for crash recovery
      try {
        this.db.saveChunks(task.id, chunks)
      } catch {
        // ignore transient busy lock
      }

      onProgress({
        downloadedBytes: currentBytes,
        totalBytes,
        speedBps: Math.round(smoothedSpeed),
        etaSec,
        percent,
        activeThreads: activeWorkers
      })
    }, 250)

    try {
      const claimNextChunkOrSteal = (): DownloadChunkRecord | null => {
        const pending = chunks.find((c) => c.status === 'pending' && c.currentByte <= c.endByte)
        if (pending) {
          pending.status = 'active'
          return pending
        }

        // Dynamic work-stealing: find the largest active chunk with >= 2 MB remaining and split it!
        let largest: DownloadChunkRecord | null = null
        let largestRem = 0
        for (const c of chunks) {
          if (c.status === 'active') {
            const rem = c.endByte - c.currentByte + 1
            if (rem > largestRem) {
              largestRem = rem
              largest = c
            }
          }
        }

        if (largest && largestRem >= MIN_SPLIT_SIZE_BYTES) {
          const mid = Math.floor((largest.currentByte + largest.endByte) / 2)
          const oldEnd = largest.endByte
          largest.endByte = mid

          const stolen: DownloadChunkRecord = {
            taskId: task.id,
            chunkIndex: chunks.length,
            startByte: mid + 1,
            currentByte: mid + 1,
            endByte: oldEnd,
            status: 'active'
          }
          chunks.push(stolen)
          return stolen
        }

        return null
      }

      const workerLoop = async (): Promise<void> => {
        while (!signal.aborted) {
          const chunk = claimNextChunkOrSteal()
          if (!chunk) return

          activeWorkers += 1
          try {
            await this.downloadChunkRange(
              task.url,
              task.requestHeaders,
              chunk,
              fileHandle,
              signal
            )
            chunk.status = 'completed'
          } finally {
            activeWorkers -= 1
          }
        }
      }

      const maxWorkers = Math.min(threadCount, Math.max(chunks.length, threadCount))
      const workers = Array.from({ length: maxWorkers }, () => workerLoop())
      await Promise.all(workers)

      this.db.saveChunks(task.id, chunks)
    } catch (err) {
      try {
        this.db.saveChunks(task.id, chunks)
      } catch {
        // ignore
      }
      if (this.stopReason === 'pause') {
        throw new PauseRequestedError()
      }
      if (this.stopReason === 'cancel') {
        throw new CancelRequestedError()
      }
      throw err
    } finally {
      clearInterval(progressTimer)
      await fileHandle.close().catch(() => {})
    }

    if (this.stopReason === 'pause') throw new PauseRequestedError()
    if (this.stopReason === 'cancel') throw new CancelRequestedError()

    if (fs.existsSync(task.savePath)) {
      await fs.promises.rm(task.savePath, { force: true })
    }
    await fs.promises.rename(partPath, task.savePath)
    this.db.saveChunks(task.id, [])

    onProgress({
      downloadedBytes: totalBytes,
      totalBytes,
      speedBps: 0,
      etaSec: 0,
      percent: 100,
      activeThreads: 0
    })
  }

  private async downloadChunkRange(
    url: string,
    headers: Record<string, string>,
    chunk: DownloadChunkRecord,
    fileHandle: fs.promises.FileHandle,
    signal: AbortSignal
  ): Promise<void> {
    if (chunk.currentByte > chunk.endByte) return

    const reqHeaders: Record<string, string> = {
      ...headers,
      Range: `bytes=${chunk.currentByte}-${chunk.endByte}`
    }

    const res = await runtimeFetch(url, {
      method: 'GET',
      headers: reqHeaders,
      redirect: 'follow',
      signal
    })

    if (res.status === 401 || res.status === 403 || res.status === 410) {
      throw new TokenExpiredError(res.status)
    }
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`HTTP ${res.status} while downloading byte range`)
    }
    if (!res.body) {
      throw new Error('Empty response stream')
    }

    const reader = res.body.getReader()
    try {
      while (chunk.currentByte <= chunk.endByte) {
        const { done, value } = await reader.read()
        if (done || !value) break

        // Respect dynamic work-stealing boundary if chunk.endByte was shrunk mid-flight!
        const allowedLen = Math.min(value.byteLength, chunk.endByte - chunk.currentByte + 1)
        if (allowedLen > 0) {
          await fileHandle.write(value, 0, allowedLen, chunk.currentByte)
          chunk.currentByte += allowedLen
        }

        if (chunk.currentByte > chunk.endByte) {
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async runSingleStream(
    task: DownloadTask,
    partPath: string,
    knownTotalBytes: number,
    signal: AbortSignal,
    onProgress: (u: DirectProgressUpdate) => void
  ): Promise<void> {
    const res = await runtimeFetch(task.url, {
      method: 'GET',
      headers: task.requestHeaders,
      redirect: 'follow',
      signal
    })

    if (res.status === 401 || res.status === 403 || res.status === 410) {
      throw new TokenExpiredError(res.status)
    }
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} on direct download`)
    }

    const totalBytes = Number(res.headers.get('content-length') || knownTotalBytes || 0)
    const fh = await fs.promises.open(partPath, 'w')
    const reader = res.body.getReader()

    let downloaded = 0
    let lastTime = Date.now()
    let lastBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done || !value) break
        await fh.write(value, 0, value.byteLength, downloaded)
        downloaded += value.byteLength

        const now = Date.now()
        if (now - lastTime >= 250) {
          const dt = (now - lastTime) / 1000
          const speedBps = Math.round((downloaded - lastBytes) / dt)
          const etaSec =
            totalBytes > 0 && speedBps > 0 ? Math.round((totalBytes - downloaded) / speedBps) : 0
          const percent = totalBytes > 0 ? Math.min(99.9, (downloaded / totalBytes) * 100) : 50
          lastTime = now
          lastBytes = downloaded

          onProgress({
            downloadedBytes: downloaded,
            totalBytes,
            speedBps,
            etaSec,
            percent,
            activeThreads: 1
          })
        }
      }
    } catch (err) {
      if (this.stopReason === 'pause') throw new PauseRequestedError()
      if (this.stopReason === 'cancel') throw new CancelRequestedError()
      throw err
    } finally {
      reader.releaseLock()
      await fh.close().catch(() => {})
    }
  }

  private async probeRemoteFile(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<{ totalBytes: number; supportsRanges: boolean }> {
    const res = await runtimeFetch(url, {
      method: 'GET',
      headers: {
        ...headers,
        Range: 'bytes=0-0'
      },
      redirect: 'follow',
      signal
    })

    if (res.status === 401 || res.status === 403 || res.status === 410) {
      await res.body?.cancel().catch(() => {})
      throw new TokenExpiredError(res.status)
    }

    const contentRange = res.headers.get('content-range') || ''
    const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase()
    const contentLength = Number(res.headers.get('content-length') || 0)

    await res.body?.cancel().catch(() => {})

    if (res.status === 206 && contentRange.includes('/')) {
      const total = Number(contentRange.split('/').pop() || 0)
      if (total > 0) {
        return { totalBytes: total, supportsRanges: true }
      }
    }

    return {
      totalBytes: contentLength > 0 ? contentLength : 0,
      supportsRanges: acceptRanges.includes('bytes') && res.status === 206
    }
  }

  private createInitialChunks(
    taskId: string,
    totalBytes: number,
    workerCount: number
  ): DownloadChunkRecord[] {
    const chunkSize = Math.ceil(totalBytes / workerCount)
    const chunks: DownloadChunkRecord[] = []
    for (let i = 0; i < workerCount; i++) {
      const startByte = i * chunkSize
      if (startByte >= totalBytes) break
      const endByte = Math.min(totalBytes - 1, (i + 1) * chunkSize - 1)
      chunks.push({
        taskId,
        chunkIndex: i,
        startByte,
        currentByte: startByte,
        endByte,
        status: 'pending'
      })
    }
    return chunks
  }

  private sumDownloadedBytes(chunks: DownloadChunkRecord[]): number {
    let sum = 0
    for (const c of chunks) {
      sum += Math.max(0, c.currentByte - c.startByte)
    }
    return sum
  }
}
