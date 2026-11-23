import crypto from 'node:crypto'
import { BrowserWindow, WebContentsView } from 'electron'
import type { InternalRoute, TabState } from '@shared/types'
import type { AdblockService } from '../adblock/AdblockService'
import type { DatabaseService } from '../storage/DatabaseService'
import { diagLogger } from '../logger/DiagnosticLogger'
import { attachPopupGuard } from './PopupGuard'
import {
  INCOGNITO_PARTITION,
  PERSIST_PARTITION,
  type SessionManager
} from './SessionManager'

export const TOOLBAR_HEIGHT = 88
export const SIDE_PANEL_WIDTH = 420

interface ManagedTab {
  state: TabState
  view: WebContentsView
  attachedToWindow: boolean
}

export interface TabLifecycleHooks {
  onAttachSniffer: (
    tabId: string,
    webContents: Electron.WebContents,
    partition: string,
    getTabState: () => TabState | undefined
  ) => void
  onDetachSniffer: (tabId: string) => void
  onClearTabMediaOnNavigate: (tabId: string, newUrl: string) => void
  onTabsBroadcast: (payload: { tabs: TabState[]; activeTabId: string | null }) => void
  onPopupBlocked?: (blockedUrl: string, isIncognito: boolean) => void
}

export class TabManager {
  private mainWindow: BrowserWindow
  private sessionManager: SessionManager
  private adblock: AdblockService
  private db: DatabaseService
  private hooks: TabLifecycleHooks

  private tabs = new Map<string, ManagedTab>()
  private tabOrder: string[] = []
  private activeTabId: string | null = null

  private isSidePanelOpen = false
  private isModalOpen = false

  constructor(
    mainWindow: BrowserWindow,
    sessionManager: SessionManager,
    adblock: AdblockService,
    db: DatabaseService,
    hooks: TabLifecycleHooks
  ) {
    this.mainWindow = mainWindow
    this.sessionManager = sessionManager
    this.adblock = adblock
    this.db = db
    this.hooks = hooks

    this.mainWindow.on('resize', () => this.updateLayout())
    this.mainWindow.on('maximize', () => this.updateLayout())
    this.mainWindow.on('unmaximize', () => this.updateLayout())
    this.mainWindow.on('enter-full-screen', () => this.updateLayout())
    this.mainWindow.on('leave-full-screen', () => this.updateLayout())
  }

  public getTabUrlByWebContentsId(wcId: number): string | undefined {
    for (const managed of this.tabs.values()) {
      if (!managed.view.webContents.isDestroyed() && managed.view.webContents.id === wcId) {
        return managed.state.url
      }
    }
    return undefined
  }

  public incrementBlockedAds(wcId: number | undefined): void {
    for (const managed of this.tabs.values()) {
      if (
        !managed.view.webContents.isDestroyed() &&
        (managed.view.webContents.id === wcId || (!wcId && managed.state.id === this.activeTabId))
      ) {
        managed.state.blockedAdsCount += 1
        this.broadcastTabsThrottled()
        break
      }
    }
  }

  public setDetectedMediaCount(tabId: string, count: number): void {
    const managed = this.tabs.get(tabId)
    if (!managed) return
    if (managed.state.detectedMediaCount !== count) {
      managed.state.detectedMediaCount = count
      this.broadcastTabs()
    }
  }

  public createTab(options?: {
    url?: string
    isIncognito?: boolean
    activate?: boolean
    internalRoute?: InternalRoute
  }): TabState {
    const id = crypto.randomUUID()
    const isIncognito = Boolean(options?.isIncognito)
    const partition = isIncognito ? INCOGNITO_PARTITION : PERSIST_PARTITION
    const sess = this.sessionManager.getSession(isIncognito)

    const initialRoute: InternalRoute =
      options?.internalRoute ?? (!options?.url || options.url === 'app://newtab' ? 'newtab' : null)

    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        spellcheck: true
      }
    })

    const state: TabState = {
      id,
      url: initialRoute ? `app://${initialRoute}` : options?.url || 'app://newtab',
      title: initialRoute ? this.routeTitle(initialRoute) : 'New Tab',
      isIncognito,
      isMuted: false,
      isAudible: false,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      blockedAdsCount: 0,
      detectedMediaCount: 0,
      isSiteWhitelisted: false,
      internalRoute: initialRoute
    }

    const managed: ManagedTab = {
      state,
      view,
      attachedToWindow: false
    }

    this.tabs.set(id, managed)
    this.tabOrder.push(id)

    this.wireWebContentsEvents(managed, partition)

    if (options?.activate !== false || !this.activeTabId) {
      this.activateTab(id)
    }

    if (!initialRoute && options?.url) {
      this.navigateTab(id, options.url)
    } else {
      this.broadcastTabs()
    }

    return { ...state }
  }

  private wireWebContentsEvents(managed: ManagedTab, partition: string): void {
    const wc = managed.view.webContents
    const id = managed.state.id

    attachPopupGuard(wc, {
      isIncognito: managed.state.isIncognito,
      adblock: this.adblock,
      onPopupBlocked: (blockedUrl, incog) => {
        managed.state.blockedAdsCount += 1
        this.hooks.onPopupBlocked?.(blockedUrl, incog)
        this.broadcastTabsThrottled()
      },
      onOpenManagedTab: (targetUrl, incog) => {
        this.createTab({ url: targetUrl, isIncognito: incog, activate: true })
      }
    })

    this.hooks.onAttachSniffer(id, wc, partition, () => this.tabs.get(id)?.state)

    wc.on('will-navigate', (_ev, targetUrl) => {
      diagLogger.log(
        'NAVIGATION',
        'will-navigate',
        { from: managed.state.url, to: targetUrl },
        { tabId: id, url: targetUrl }
      )
    })

    wc.on('did-redirect-navigation', (_ev, targetUrl, _isInPlace, isMainFrame) => {
      diagLogger.log(
        'NAVIGATION',
        'did-redirect-navigation',
        { to: targetUrl, isMainFrame },
        { tabId: id, url: targetUrl }
      )
    })

    wc.on('frame-created', (_ev, details) => {
      const frame = details.frame
      if (!frame) return
      frame.once('dom-ready', () => {
        try {
          diagLogger.log(
            'FRAME',
            'frame-dom-ready',
            { frameUrl: frame.url, name: frame.name },
            { tabId: id, url: managed.state.url }
          )
        } catch {
          // frame destroyed
        }
      })
    })

    wc.on('did-start-loading', () => {
      if (managed.state.internalRoute) return
      managed.state.isLoading = true
      this.syncNavigationFlags(managed)
      this.broadcastTabs()
    })

    wc.on('did-stop-loading', () => {
      managed.state.isLoading = false
      this.syncNavigationFlags(managed)
      if (!managed.state.internalRoute) {
        this.db.recordHistoryVisit({
          url: managed.state.url,
          title: managed.state.title,
          favicon: managed.state.favicon,
          isIncognito: managed.state.isIncognito
        })
      }
      this.broadcastTabs()
    })

    wc.on('did-navigate', (_event, url) => {
      if (url === 'about:blank' && managed.state.internalRoute) return
      const prevOrigin = this.safeOrigin(managed.state.url)
      const nextOrigin = this.safeOrigin(url)
      if (prevOrigin !== nextOrigin) {
        managed.state.blockedAdsCount = 0
      }
      this.hooks.onClearTabMediaOnNavigate(id, url)
      managed.state.internalRoute = null
      managed.state.url = url
      managed.state.isSiteWhitelisted = this.adblock.isDomainWhitelisted(url)
      this.syncNavigationFlags(managed)
      this.updateLayout()
      this.broadcastTabs()
    })

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      if (url === 'about:blank' && managed.state.internalRoute) return
      const prevUrl = managed.state.url
      managed.state.url = url
      managed.state.isSiteWhitelisted = this.adblock.isDomainWhitelisted(url)
      this.syncNavigationFlags(managed)
      // Many SPAs (YouTube, Twitch, streaming sites) switch videos via pushState!
      if (prevUrl !== url) {
        this.db.recordHistoryVisit({
          url,
          title: managed.state.title,
          favicon: managed.state.favicon,
          isIncognito: managed.state.isIncognito
        })
      }
      this.broadcastTabs()
    })

    wc.on('page-title-updated', (_event, title) => {
      if (managed.state.internalRoute) return
      managed.state.title = title || managed.state.url
      this.broadcastTabs()
    })

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (favicons && favicons.length > 0) {
        managed.state.favicon = favicons[0]
        this.broadcastTabsThrottled()
      }
    })

    wc.on('media-started-playing', () => {
      managed.state.isAudible = true
      this.broadcastTabs()
    })

    wc.on('media-paused', () => {
      managed.state.isAudible = false
      this.broadcastTabs()
    })

    // Keyboard shortcuts when focus is inside the embedded website WebContentsView
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const ctrl = input.control || input.meta
      const key = input.key.toLowerCase()

      if (ctrl && !input.shift && key === 't') {
        event.preventDefault()
        this.createTab({ activate: true })
      } else if (ctrl && input.shift && key === 'n') {
        event.preventDefault()
        this.createTab({ isIncognito: true, activate: true })
      } else if (ctrl && key === 'w') {
        event.preventDefault()
        this.closeTab(id)
      } else if ((ctrl && key === 'r') || input.key === 'F5') {
        event.preventDefault()
        this.reloadTab(id)
      } else if (input.alt && input.key === 'ArrowLeft') {
        event.preventDefault()
        this.goBack(id)
      } else if (input.alt && input.key === 'ArrowRight') {
        event.preventDefault()
        this.goForward(id)
      }
    })
  }

  private syncNavigationFlags(managed: ManagedTab): void {
    const wc = managed.view.webContents
    if (wc.isDestroyed()) return
    managed.state.canGoBack = wc.navigationHistory.canGoBack()
    managed.state.canGoForward = wc.navigationHistory.canGoForward()
  }

  public activateTab(tabId: string): void {
    if (!this.tabs.has(tabId)) return
    this.activeTabId = tabId
    this.updateLayout()
    this.broadcastTabs()
  }

  public closeTab(tabId: string): void {
    const managed = this.tabs.get(tabId)
    if (!managed) return

    const wasIncognito = managed.state.isIncognito
    const idx = this.tabOrder.indexOf(tabId)

    this.hooks.onDetachSniffer(tabId)

    if (managed.attachedToWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.contentView.removeChildView(managed.view)
      managed.attachedToWindow = false
    }

    if (!managed.view.webContents.isDestroyed()) {
      managed.view.webContents.close()
    }

    this.tabs.delete(tabId)
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId)

    if (wasIncognito) {
      const anyIncognitoLeft = Array.from(this.tabs.values()).some((t) => t.state.isIncognito)
      if (!anyIncognitoLeft) {
        void this.sessionManager.wipeIncognitoData()
      }
    }

    if (this.tabOrder.length === 0) {
      this.createTab({ internalRoute: 'newtab', activate: true })
      return
    }

    if (this.activeTabId === tabId) {
      const nextIdx = Math.min(idx, this.tabOrder.length - 1)
      this.activeTabId = this.tabOrder[Math.max(0, nextIdx)]
    }

    this.updateLayout()
    this.broadcastTabs()
  }

  public navigateTab(tabId: string, rawInput: string): void {
    const managed = this.tabs.get(tabId)
    if (!managed) return

    const trimmed = rawInput.trim()
    if (!trimmed) return

    if (trimmed.startsWith('app://')) {
      const route = trimmed.replace('app://', '') as InternalRoute
      this.openInternalRoute(tabId, route || 'newtab')
      return
    }

    const finalUrl = this.normalizeUrlOrSearch(trimmed)
    managed.state.internalRoute = null
    managed.state.url = finalUrl
    managed.state.isLoading = true
    managed.state.isSiteWhitelisted = this.adblock.isDomainWhitelisted(finalUrl)

    this.updateLayout()
    this.broadcastTabs()
    void managed.view.webContents.loadURL(finalUrl).catch((err) => {
      console.warn('[TabManager] Navigation warning:', err?.message || err)
    })
  }

  public openInternalRoute(tabId: string | null, route: Exclude<InternalRoute, null>): void {
    if (!tabId) {
      // Check if a tab with this internal route is already open
      const existing = Array.from(this.tabs.values()).find((t) => t.state.internalRoute === route)
      if (existing) {
        this.activateTab(existing.state.id)
        return
      }
      this.createTab({ internalRoute: route, activate: true })
      return
    }

    const managed = this.tabs.get(tabId)
    if (!managed) return
    managed.state.internalRoute = route
    managed.state.url = `app://${route}`
    managed.state.title = this.routeTitle(route)
    managed.state.isLoading = false
    this.updateLayout()
    this.broadcastTabs()
  }

  public goBack(tabId: string): void {
    const managed = this.tabs.get(tabId)
    if (!managed) return
    if (managed.state.internalRoute && managed.view.webContents.getURL()) {
      managed.state.internalRoute = null
      managed.state.url = managed.view.webContents.getURL()
      this.updateLayout()
      this.broadcastTabs()
      return
    }
    if (managed.view.webContents.navigationHistory.canGoBack()) {
      managed.view.webContents.navigationHistory.goBack()
    }
  }

  public goForward(tabId: string): void {
    const managed = this.tabs.get(tabId)
    if (managed?.view.webContents.navigationHistory.canGoForward()) {
      managed.view.webContents.navigationHistory.goForward()
    }
  }

  public reloadTab(tabId: string): void {
    const managed = this.tabs.get(tabId)
    if (!managed || managed.state.internalRoute) return
    managed.view.webContents.reload()
  }

  public toggleMute(tabId: string): void {
    const managed = this.tabs.get(tabId)
    if (!managed) return
    managed.state.isMuted = !managed.state.isMuted
    managed.view.webContents.setAudioMuted(managed.state.isMuted)
    this.broadcastTabs()
  }

  public refreshWhitelistStates(): void {
    for (const managed of this.tabs.values()) {
      managed.state.isSiteWhitelisted = this.adblock.isDomainWhitelisted(managed.state.url)
    }
    this.broadcastTabs()
  }

  public setSidePanelOpen(open: boolean): void {
    if (this.isSidePanelOpen === open) return
    this.isSidePanelOpen = open
    this.updateLayout()
  }

  public setModalOpen(open: boolean): void {
    if (this.isModalOpen === open) return
    this.isModalOpen = open
    this.updateLayout()
  }

  public updateLayout(): void {
    if (this.mainWindow.isDestroyed()) return
    const [winWidth, winHeight] = this.mainWindow.getContentSize()

    for (const [id, managed] of this.tabs.entries()) {
      const shouldShowWebview =
        id === this.activeTabId &&
        managed.state.internalRoute === null &&
        !this.isModalOpen

      if (shouldShowWebview) {
        if (!managed.attachedToWindow) {
          this.mainWindow.contentView.addChildView(managed.view)
          managed.attachedToWindow = true
        }
        managed.view.setVisible(true)
        const availWidth = Math.max(320, winWidth - (this.isSidePanelOpen ? SIDE_PANEL_WIDTH : 0))
        const availHeight = Math.max(180, winHeight - TOOLBAR_HEIGHT)
        managed.view.setBounds({
          x: 0,
          y: TOOLBAR_HEIGHT,
          width: availWidth,
          height: availHeight
        })
      } else if (managed.attachedToWindow) {
        managed.view.setVisible(false)
        this.mainWindow.contentView.removeChildView(managed.view)
        managed.attachedToWindow = false
      }
    }
  }

  public getStateSnapshot(): { tabs: TabState[]; activeTabId: string | null } {
    const tabs = this.tabOrder
      .map((id) => this.tabs.get(id)?.state)
      .filter((s): s is TabState => Boolean(s))
      .map((s) => ({ ...s }))
    return { tabs, activeTabId: this.activeTabId }
  }

  public getTabWebContents(tabId: string): Electron.WebContents | null {
    const managed = this.tabs.get(tabId)
    if (!managed || managed.view.webContents.isDestroyed()) return null
    return managed.view.webContents
  }

  public getTabState(tabId: string): TabState | undefined {
    return this.tabs.get(tabId)?.state
  }

  private broadcastTimer: NodeJS.Timeout | null = null
  private broadcastTabsThrottled(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      this.broadcastTabs()
    }, 180)
  }

  public broadcastTabs(): void {
    this.hooks.onTabsBroadcast(this.getStateSnapshot())
  }

  private normalizeUrlOrSearch(input: string): string {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(input)) {
      return input
    }
    const looksLikeHost =
      !input.includes(' ') &&
      (input.startsWith('localhost') ||
        /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(input) ||
        /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/.test(input))

    if (looksLikeHost) {
      return input.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(input)
        ? `http://${input}`
        : `https://${input}`
    }

    const q = encodeURIComponent(input)
    const engine = this.db.getSettings().searchEngine
    if (engine === 'google') return `https://www.google.com/search?q=${q}`
    if (engine === 'bing') return `https://www.bing.com/search?q=${q}`
    return `https://duckduckgo.com/?q=${q}`
  }

  private routeTitle(route: Exclude<InternalRoute, null>): string {
    switch (route) {
      case 'newtab':
        return 'New Tab'
      case 'downloads':
        return 'Downloads Manager'
      case 'bookmarks':
        return 'Bookmarks'
      case 'history':
        return 'Browsing History'
      case 'settings':
        return 'Settings & Portable Tools'
    }
  }

  private safeOrigin(url: string): string {
    try {
      return new URL(url).origin
    } catch {
      return ''
    }
  }
}
