import fs from 'node:fs'
import path from 'node:path'
import { session, type Session, type WebContents } from 'electron'
import type { AdblockService } from '../adblock/AdblockService'
import type { DatabaseService } from '../storage/DatabaseService'
import { computeCleanChromeUserAgent } from './StealthNormalizer'

export const PERSIST_PARTITION = 'persist:browser'
export const INCOGNITO_PARTITION = 'incognito'

export interface InterceptedStandardDownload {
  url: string
  filename: string
  totalBytes: number
  mimeType: string
  sourcePageUrl: string
  partition: string
  requestHeaders: Record<string, string>
}

export class SessionManager {
  private persistSession!: Session
  private incognitoSession!: Session
  private db: DatabaseService
  private adblock: AdblockService
  private snifferPreloadPath: string
  private onStandardDownload?: (info: InterceptedStandardDownload) => void

  constructor(
    db: DatabaseService,
    adblock: AdblockService,
    snifferPreloadPath: string,
    onStandardDownload?: (info: InterceptedStandardDownload) => void
  ) {
    this.db = db
    this.adblock = adblock
    this.snifferPreloadPath = snifferPreloadPath
    this.onStandardDownload = onStandardDownload
  }

  public initialize(): void {
    this.persistSession = session.fromPartition(PERSIST_PARTITION, { cache: true })
    this.incognitoSession = session.fromPartition(INCOGNITO_PARTITION, { cache: false })

    this.configureSession(this.persistSession, PERSIST_PARTITION)
    this.configureSession(this.incognitoSession, INCOGNITO_PARTITION)
  }

  private configureSession(sess: Session, partitionName: string): void {
    const cleanUa = computeCleanChromeUserAgent()
    sess.setUserAgent(cleanUa)

    // Attach Ghostery Adblocker + per-domain whitelist multiplexer + Stealth Client Hints
    this.adblock.attachToSession(sess)

    // Register frame-wide sniffer preload (runs in main frames + all nested cross-origin iframes)
    if (fs.existsSync(this.snifferPreloadPath)) {
      sess.registerPreloadScript({
        type: 'frame',
        filePath: this.snifferPreloadPath
      })
    } else {
      console.warn('[SessionManager] Sniffer preload not found at:', this.snifferPreloadPath)
    }

    // Route regular file downloads into our 16-32 thread HTTP Range Downloader
    sess.on('will-download', (event, item, webContents: WebContents | undefined) => {
      const url = item.getURL()
      if (
        !this.db.getSettings().interceptStandardDownloads ||
        (!url.startsWith('http://') && !url.startsWith('https://'))
      ) {
        return
      }

      event.preventDefault()

      const filename = item.getFilename() || path.basename(new URL(url).pathname) || 'download.bin'
      const totalBytes = item.getTotalBytes()
      const mimeType = item.getMimeType()
      const sourcePageUrl = webContents?.getURL() || url

      void (async () => {
        const cookies = await sess.cookies.get({ url }).catch(() => [])
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        const headers: Record<string, string> = {
          'User-Agent': cleanUa,
          Referer: sourcePageUrl
        }
        if (cookieHeader) {
          headers.Cookie = cookieHeader
        }

        this.onStandardDownload?.({
          url,
          filename,
          totalBytes,
          mimeType,
          sourcePageUrl,
          partition: partitionName,
          requestHeaders: headers
        })
      })()
    })
  }

  public getSession(isIncognito: boolean): Session {
    return isIncognito ? this.incognitoSession : this.persistSession
  }

  public getSessionByPartition(partition: string): Session {
    return partition === INCOGNITO_PARTITION ? this.incognitoSession : this.persistSession
  }

  public async wipeIncognitoData(): Promise<void> {
    if (!this.incognitoSession) return
    await Promise.allSettled([
      this.incognitoSession.clearStorageData(),
      this.incognitoSession.clearCache(),
      this.incognitoSession.clearAuthCache()
    ])
  }
}
