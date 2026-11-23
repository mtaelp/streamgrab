import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, net, type Session } from 'electron'
import { ElectronBlocker, fullLists, Request } from '@ghostery/adblocker-electron'
import crossFetch from 'cross-fetch'
import type { DatabaseService } from '../storage/DatabaseService'
import { resolvePortablePaths } from '../portable/PortablePaths'
import {
  createAdblockSessionProxy,
  extractHostname,
  isDomainInWhitelist
} from './WebRequestMultiplexer'

/**
 * Full uBlock + EasyList + EasyPrivacy + Peter Lowe + AdGuard Turkish & Popups filter lists.
 * Blocks regional ad/promo banners, pre-roll video ad servers,
 * and aggressive pop-under scripts on international & regional streaming sites.
 */
const EXTENDED_FILTER_LISTS = [
  ...fullLists,
  // AdGuard Turkish Filter (blocks Turkish betting banners, overlays & pre-roll video ads)
  'https://filters.adtidy.org/extension/ublock/filters/13.txt',
  // AdGuard Popups & Annoyances Filter
  'https://filters.adtidy.org/extension/ublock/filters/19.txt'
]

export class AdblockService {
  private blocker: ElectronBlocker | null = null
  private db: DatabaseService
  private getTabUrlByWebContentsId: (wcId: number) => string | undefined
  private onAdBlockedCallback?: (webContentsId: number | undefined, blockedUrl: string) => void

  constructor(
    db: DatabaseService,
    getTabUrlByWebContentsId: (wcId: number) => string | undefined,
    onAdBlocked?: (webContentsId: number | undefined, blockedUrl: string) => void
  ) {
    this.db = db
    this.getTabUrlByWebContentsId = getTabUrlByWebContentsId
    this.onAdBlockedCallback = onAdBlocked
  }

  public async initialize(): Promise<void> {
    const paths = resolvePortablePaths()
    const cachePath = path.join(paths.userDataDir, 'adblock-engine-v2.bin')

    const electronFetch = (
      typeof net?.fetch === 'function' ? (url: string) => net.fetch(url) : crossFetch
    ) as unknown as typeof crossFetch

    try {
      this.blocker = await ElectronBlocker.fromLists(
        electronFetch,
        EXTENDED_FILTER_LISTS,
        { enableCompression: true },
        {
          path: cachePath,
          read: fs.promises.readFile,
          write: fs.promises.writeFile
        }
      )
    } catch (err) {
      console.warn('[AdblockService] Extended lists fetch warning, falling back to prebuilt/cached:', err)
      try {
        if (fs.existsSync(cachePath)) {
          const raw = await fs.promises.readFile(cachePath)
          this.blocker = ElectronBlocker.deserialize(new Uint8Array(raw))
        } else {
          this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(electronFetch)
        }
      } catch {
        this.blocker = ElectronBlocker.empty()
      }
    }

    this.blocker.on('request-blocked', (request: Request) => {
      const wcId = (request as unknown as { sourceId?: number; tabId?: number }).tabId
      this.onAdBlockedCallback?.(wcId, request.url)
    })
  }

  public attachToSession(session: Session): void {
    if (!this.blocker) return

    const proxiedSession = createAdblockSessionProxy(session, {
      isAdblockEnabled: () => this.db.getSettings().adblockEnabled,
      isUrlOrTabWhitelisted: ({ url, referrer, webContentsId }) => {
        const whitelist = this.db.getSettings().whitelistedDomains
        if (whitelist.length === 0) return false

        const tabUrl = webContentsId ? this.getTabUrlByWebContentsId(webContentsId) : undefined
        const tabHost = extractHostname(tabUrl)
        if (isDomainInWhitelist(tabHost, whitelist)) return true

        const refHost = extractHostname(referrer)
        if (isDomainInWhitelist(refHost, whitelist)) return true

        const reqHost = extractHostname(url)
        return isDomainInWhitelist(reqHost, whitelist)
      }
    })

    // Clear global IPC handlers before attaching additional sessions (e.g., incognito)
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
    ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled')

    this.blocker.enableBlockingInSession(proxiedSession)
  }

  public isPopupUrlBlocked(targetUrl: string, sourceUrl: string): boolean {
    const settings = this.db.getSettings()
    if (!settings.adblockEnabled || !this.blocker) return false

    const sourceHost = extractHostname(sourceUrl)
    if (isDomainInWhitelist(sourceHost, settings.whitelistedDomains)) {
      return false
    }

    try {
      for (const reqType of ['popup', 'document', 'sub_frame'] as const) {
        const req = Request.fromRawDetails({
          url: targetUrl,
          sourceUrl,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          type: reqType as any
        })
        if (this.blocker.match(req).match) {
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  public isDomainWhitelisted(urlOrHost?: string): boolean {
    const host = urlOrHost?.includes('://') ? extractHostname(urlOrHost) : urlOrHost ?? null
    return isDomainInWhitelist(host, this.db.getSettings().whitelistedDomains)
  }

  public toggleDomainWhitelist(urlOrHost: string): { whitelisted: boolean; domain: string } {
    const host = (urlOrHost.includes('://') ? extractHostname(urlOrHost) : urlOrHost)
      ?.toLowerCase()
      .replace(/^www\./, '')
    if (!host) {
      return { whitelisted: false, domain: '' }
    }

    const current = this.db.getSettings().whitelistedDomains
    const exists = isDomainInWhitelist(host, current)
    const next = exists
      ? current.filter((d) => d.toLowerCase().replace(/^www\./, '') !== host)
      : [...current, host]

    this.db.updateSettings({ whitelistedDomains: next })
    return { whitelisted: !exists, domain: host }
  }
}
