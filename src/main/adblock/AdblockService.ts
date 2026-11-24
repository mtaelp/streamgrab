import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, net, type Session } from 'electron'
import { ElectronBlocker, fullLists, Request } from '@ghostery/adblocker-electron'
import crossFetch from 'cross-fetch'
import type { DatabaseService } from '../storage/DatabaseService'
import { diagLogger } from '../logger/DiagnosticLogger'
import { resolvePortablePaths } from '../portable/PortablePaths'
import {
  createAdblockSessionProxy,
  extractHostname,
  isDomainInWhitelist
} from './WebRequestMultiplexer'

/**
 * Brave Shields (MPL-2.0) + Live uBlock Origin uAssets (2025/2026 + daily quick-fixes)
 * + EasyList / EasyPrivacy + AdGuard Regional & Popups.
 *
 * Mirrors Brave Browser's open-source filter stack for network, cosmetic, scriptlet (+js),
 * YouTube ad/anti-adblock mitigation, and regional streaming pop-under protection.
 */
export const BRAVE_AND_UASSETS_FILTER_LISTS = [
  // 1. Official Brave Browser Shields Lists (MPL-2.0)
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt',
  'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-sugarcoat.txt',

  // 2. Live uBlock Origin uAssets (including daily YouTube quick-fixes & 2025/2026 rules)
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2025.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters-2026.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt',

  // 3. Standard EasyList, EasyPrivacy & Peter Lowe
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',

  // 4. AdGuard Regional & Popups Filters (blocks regional banners, pre-roll servers & pop-unders)
  'https://filters.adtidy.org/extension/ublock/filters/13.txt',
  'https://filters.adtidy.org/extension/ublock/filters/19.txt'
]

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // Auto-refresh Brave + uBlock quick-fixes every 12 hours

export class AdblockService {
  private blocker: ElectronBlocker | null = null
  private db: DatabaseService
  private getTabUrlByWebContentsId: (wcId: number) => string | undefined
  private onAdBlockedCallback?: (webContentsId: number | undefined, blockedUrl: string) => void
  private internalIpcRegistered = false

  constructor(
    db: DatabaseService,
    getTabUrlByWebContentsId: (wcId: number) => string | undefined,
    onAdBlocked?: (webContentsId: number | undefined, blockedUrl: string) => void
  ) {
    this.db = db
    this.getTabUrlByWebContentsId = getTabUrlByWebContentsId
    this.onAdBlockedCallback = onAdBlocked
  }

  private getElectronFetch(): typeof crossFetch {
    return (
      typeof net?.fetch === 'function' ? (url: string) => net.fetch(url) : crossFetch
    ) as unknown as typeof crossFetch
  }

  public async initialize(): Promise<void> {
    const paths = resolvePortablePaths()
    const cachePath = path.join(paths.userDataDir, 'adblock-engine-brave-v3.bin')
    const electronFetch = this.getElectronFetch()

    let loadedFromFreshCache = false
    if (fs.existsSync(cachePath)) {
      try {
        const stat = await fs.promises.stat(cachePath)
        const raw = await fs.promises.readFile(cachePath)
        this.blocker = ElectronBlocker.deserialize(new Uint8Array(raw))
        const isFresh = Date.now() - stat.mtimeMs < CACHE_TTL_MS
        loadedFromFreshCache = true

        if (!isFresh) {
          // Non-blocking background refresh so startup is instant (<30ms) while keeping YouTube quick-fixes fresh
          void this.refreshEngineInBackground(cachePath)
        }
      } catch {
        loadedFromFreshCache = false
      }
    }

    if (!loadedFromFreshCache) {
      try {
        this.blocker = await ElectronBlocker.fromLists(
          electronFetch,
          BRAVE_AND_UASSETS_FILTER_LISTS,
          { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true },
          {
            path: cachePath,
            read: fs.promises.readFile,
            write: fs.promises.writeFile
          }
        )
      } catch (err) {
        console.warn('[AdblockService] Brave/uAssets lists fetch warning, falling back to Ghostery fullLists:', err)
        try {
          this.blocker = await ElectronBlocker.fromLists(electronFetch, fullLists, {
            enableCompression: true
          })
        } catch {
          try {
            this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(electronFetch)
          } catch {
            this.blocker = ElectronBlocker.empty()
          }
        }
      }
    }

    this.wireBlockerEvents(this.blocker!)
    this.registerInternalShieldSyncIpc()
  }

  private wireBlockerEvents(blocker: ElectronBlocker): void {
    blocker.on('request-blocked', (request: Request) => {
      const wcId = (request as unknown as { sourceId?: number; tabId?: number }).tabId
      this.onAdBlockedCallback?.(wcId, request.url)
    })
    blocker.on('request-redirected', (request: Request) => {
      const wcId = (request as unknown as { sourceId?: number; tabId?: number }).tabId
      this.onAdBlockedCallback?.(wcId, request.url)
    })
  }

  private async refreshEngineInBackground(cachePath: string): Promise<void> {
    try {
      const electronFetch = this.getElectronFetch()
      const updated = await ElectronBlocker.fromLists(
        electronFetch,
        BRAVE_AND_UASSETS_FILTER_LISTS,
        { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true }
      )
      await fs.promises.writeFile(cachePath, Buffer.from(updated.serialize()))
      diagLogger.log('ADBLOCK', 'brave_lists_refreshed_background', { cachePath })
    } catch {
      // Keep running with existing deserialized engine if offline
    }
  }

  private registerInternalShieldSyncIpc(): void {
    if (this.internalIpcRegistered) return
    this.internalIpcRegistered = true

    // Fast synchronous check used at document_start by preload YouTube shield
    ipcMain.on('sg-internal:should-shield-frame', (event, frameUrl: string) => {
      event.returnValue = this.shouldShieldUrl(frameUrl, event.sender?.id)
    })

    ipcMain.on('sg-internal:youtube-ad-pruned', (event, count: number) => {
      const wcId = event.sender?.id
      const n = Math.max(1, Math.min(5, Number(count) || 1))
      for (let i = 0; i < n; i++) {
        this.onAdBlockedCallback?.(wcId, 'https://www.youtube.com/#player-ad-pruned')
      }
    })
  }

  public shouldShieldUrl(url?: string, webContentsId?: number): boolean {
    const settings = this.db.getSettings()
    if (!settings.adblockEnabled) return false

    const whitelist = settings.whitelistedDomains
    if (whitelist.length === 0) return true

    if (webContentsId) {
      const tabUrl = this.getTabUrlByWebContentsId(webContentsId)
      if (isDomainInWhitelist(extractHostname(tabUrl), whitelist)) return false
    }

    return !isDomainInWhitelist(extractHostname(url), whitelist)
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

    // Wrap Ghostery's cosmetic & scriptlet IPC handler so disabling Shield or whitelisting a domain
    // also skips CSS & +js(...) scriptlet injection cleanly!
    ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters')
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', async (event, url: string, msg: unknown) => {
      if (!this.shouldShieldUrl(url, event.sender?.id)) {
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.blocker as any).onInjectCosmeticFilters(event, url, msg)
    })
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
