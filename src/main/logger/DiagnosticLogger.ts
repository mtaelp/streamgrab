import fs from 'node:fs'
import path from 'node:path'
import { resolvePortablePaths } from '../portable/PortablePaths'

export type LogCategory =
  | 'LIFECYCLE'
  | 'NAVIGATION'
  | 'POPUP'
  | 'DOM_CLICK'
  | 'WINDOW_OPEN_JS'
  | 'FRAME'
  | 'CDP_TARGET'
  | 'CDP_NETWORK'
  | 'CDP_BODY'
  | 'PRELOAD_HOOK'
  | 'MSE_CODEC'
  | 'VIDEO_ELEMENT'
  | 'MANIFEST_PARSED'
  | 'DOWNLOAD_CMD'
  | 'DOWNLOAD_OUT'
  | 'ADBLOCK'

export interface DiagnosticLogEntry {
  seq: number
  ts: string
  epochMs: number
  category: LogCategory
  event: string
  tabId?: string
  url?: string
  data?: unknown
}

class DiagnosticLoggerImpl {
  private seq = 0
  private jsonlPath = ''
  private readablePath = ''
  private manifestsDumpDir = ''
  private initialized = false
  private recentBuffer: DiagnosticLogEntry[] = []

  public init(): void {
    if (this.initialized) return
    const paths = resolvePortablePaths()
    this.jsonlPath = path.join(paths.logsDir, 'sniffer-debug.jsonl')
    this.readablePath = path.join(paths.logsDir, 'sniffer-debug.log')
    this.manifestsDumpDir = path.join(paths.logsDir, 'captured-manifests')

    fs.mkdirSync(paths.logsDir, { recursive: true })
    fs.mkdirSync(this.manifestsDumpDir, { recursive: true })

    // Start each session with a clear session banner
    this.initialized = true
    this.log('LIFECYCLE', 'SESSION_START', {
      portableRoot: paths.portableRoot,
      jsonlPath: this.jsonlPath
    })
  }

  public clearLogs(): { jsonlPath: string; eventCount: number } {
    this.init()
    this.seq = 0
    this.recentBuffer = []
    fs.writeFileSync(this.jsonlPath, '', 'utf8')
    fs.writeFileSync(this.readablePath, '', 'utf8')
    this.log('LIFECYCLE', 'LOGS_CLEARED_BY_USER', {})
    return { jsonlPath: this.jsonlPath, eventCount: this.seq }
  }

  public getStatus(): { jsonlPath: string; readablePath: string; eventCount: number; recent: DiagnosticLogEntry[] } {
    this.init()
    return {
      jsonlPath: this.jsonlPath,
      readablePath: this.readablePath,
      eventCount: this.seq,
      recent: this.recentBuffer.slice(-80)
    }
  }

  public dumpRawArtifact(prefix: string, ext: string, content: string): string {
    this.init()
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const filename = `${Date.now()}_${this.seq}_${safePrefix}.${ext}`
    const fullPath = path.join(this.manifestsDumpDir, filename)
    try {
      fs.writeFileSync(fullPath, content, 'utf8')
    } catch {
      // ignore disk error
    }
    return fullPath
  }

  public log(
    category: LogCategory,
    event: string,
    data?: unknown,
    meta?: { tabId?: string; url?: string }
  ): void {
    if (!this.initialized) {
      this.init()
    }

    this.seq += 1
    const now = new Date()
    const entry: DiagnosticLogEntry = {
      seq: this.seq,
      ts: now.toISOString(),
      epochMs: now.getTime(),
      category,
      event,
      tabId: meta?.tabId,
      url: meta?.url,
      data
    }

    this.recentBuffer.push(entry)
    if (this.recentBuffer.length > 200) {
      this.recentBuffer.shift()
    }

    try {
      fs.appendFileSync(this.jsonlPath, `${JSON.stringify(entry)}\n`, 'utf8')
      const summary =
        data !== undefined
          ? typeof data === 'string'
            ? data
            : JSON.stringify(data).slice(0, 800)
          : ''
      fs.appendFileSync(
        this.readablePath,
        `[${entry.ts}] #${entry.seq} [${category}:${event}]${meta?.url ? ` (${meta.url})` : ''} ${summary}\n`,
        'utf8'
      )
    } catch {
      // never crash app due to logging
    }
  }
}

export const diagLogger = new DiagnosticLoggerImpl()
