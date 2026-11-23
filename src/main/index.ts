import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { AppSettings, DetectedMedia, InternalRoute, TrackSelection } from '@shared/types'
import { AdblockService } from './adblock/AdblockService'
import { BinaryManager } from './binaries/BinaryManager'
import { SessionManager } from './browser/SessionManager'
import { applyGlobalStealthFlags } from './browser/StealthNormalizer'
import { TabManager } from './browser/TabManager'
import { DownloadOrchestrator } from './downloader/DownloadOrchestrator'
import { diagLogger } from './logger/DiagnosticLogger'
import { applyPortableElectronPaths, resolvePortablePaths } from './portable/PortablePaths'
import { HeadlessSniffer } from './sniffer/HeadlessSniffer'
import { SnifferManager } from './sniffer/SnifferManager'
import { YtDlpInspector } from './sniffer/YtDlpInspector'
import { DatabaseService } from './storage/DatabaseService'

// 1. Apply 100% portable paths inside <portableRoot>/data BEFORE app.whenReady()
applyPortableElectronPaths(app)
applyGlobalStealthFlags(app)

let mainWindow: BrowserWindow | null = null
let dbService: DatabaseService | null = null
let tabManager: TabManager | null = null

function sendToShell(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function bootstrapApplication(): Promise<void> {
  const db = new DatabaseService()
  dbService = db
  const binaries = new BinaryManager()
  const ytdlpInspector = new YtDlpInspector(binaries)

  const shellPreloadPath = path.join(__dirname, '../preload/shell-preload.js')
  const snifferPreloadPath = path.join(__dirname, '../preload/sniffer-preload.js')

  const adblock = new AdblockService(
    db,
    (wcId) => tabManager?.getTabUrlByWebContentsId(wcId),
    (wcId) => tabManager?.incrementBlockedAds(wcId)
  )
  await adblock.initialize()

  let orchestrator!: DownloadOrchestrator

  const sessionManager = new SessionManager(
    db,
    adblock,
    snifferPreloadPath,
    (standardDl) => {
      if (!orchestrator) return
      orchestrator.startFromStandardBrowserDownload(standardDl)
    }
  )
  sessionManager.initialize()

  const snifferManager = new SnifferManager(
    db,
    sessionManager,
    ytdlpInspector,
    (tabId, list) => {
      tabManager?.setDetectedMediaCount(tabId, list.length)
      sendToShell(IPC_CHANNELS.MEDIA_UPDATED, { tabId, media: list })
    }
  )

  const headlessSniffer = new HeadlessSniffer(
    sessionManager,
    adblock,
    snifferManager,
    ytdlpInspector,
    (jobs) => sendToShell(IPC_CHANNELS.HEADLESS_UPDATED, jobs)
  )

  orchestrator = new DownloadOrchestrator(
    db,
    binaries,
    sessionManager,
    headlessSniffer,
    (tasks) => sendToShell(IPC_CHANNELS.DOWNLOADS_UPDATED, tasks)
  )

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'StreamGrab Browser',
    backgroundColor: '#09090b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: shellPreloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  tabManager = new TabManager(mainWindow, sessionManager, adblock, db, {
    onAttachSniffer: (tabId, wc, partition, getTabState) => {
      snifferManager.attachToTab(tabId, wc, partition, getTabState)
    },
    onDetachSniffer: (tabId) => {
      snifferManager.detachFromTab(tabId)
    },
    onClearTabMediaOnNavigate: (tabId, newUrl) => {
      snifferManager.handleTabNavigation(tabId, newUrl)
    },
    onTabsBroadcast: (snapshot) => {
      sendToShell(IPC_CHANNELS.TABS_UPDATED, snapshot)
    },
    onPopupBlocked: (blockedUrl, isIncognito) => {
      sendToShell(IPC_CHANNELS.POPUP_BLOCKED_EVENT, { url: blockedUrl, isIncognito })
    }
  })

  registerIpcHandlers({
    db,
    binaries,
    adblock,
    tabManager,
    snifferManager,
    headlessSniffer,
    orchestrator
  })

  // Create initial home tab
  tabManager.createTab({ internalRoute: 'newtab', activate: true })

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(deps: {
  db: DatabaseService
  binaries: BinaryManager
  adblock: AdblockService
  tabManager: TabManager
  snifferManager: SnifferManager
  headlessSniffer: HeadlessSniffer
  orchestrator: DownloadOrchestrator
}): void {
  const {
    db,
    binaries,
    adblock,
    tabManager: tabs,
    snifferManager,
    headlessSniffer,
    orchestrator
  } = deps

  // Tabs & Navigation
  ipcMain.handle(IPC_CHANNELS.TABS_GET_STATE, () => tabs.getStateSnapshot())
  ipcMain.handle(IPC_CHANNELS.TABS_CREATE, (_e, opts) => tabs.createTab(opts))
  ipcMain.handle(IPC_CHANNELS.TABS_CLOSE, (_e, tabId: string) => tabs.closeTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TABS_ACTIVATE, (_e, tabId: string) => tabs.activateTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TABS_NAVIGATE, (_e, tabId: string, input: string) =>
    tabs.navigateTab(tabId, input)
  )
  ipcMain.handle(IPC_CHANNELS.TABS_GO_BACK, (_e, tabId: string) => tabs.goBack(tabId))
  ipcMain.handle(IPC_CHANNELS.TABS_GO_FORWARD, (_e, tabId: string) => tabs.goForward(tabId))
  ipcMain.handle(IPC_CHANNELS.TABS_RELOAD, (_e, tabId: string) => tabs.reloadTab(tabId))
  ipcMain.handle(IPC_CHANNELS.TABS_TOGGLE_MUTE, (_e, tabId: string) => tabs.toggleMute(tabId))
  ipcMain.handle(
    IPC_CHANNELS.TABS_OPEN_INTERNAL,
    (_e, tabId: string | null, route: Exclude<InternalRoute, null>) =>
      tabs.openInternalRoute(tabId, route)
  )

  // Layout sync (Side-panel & Modals vs native WebContentsView bounds)
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SET_SIDE_PANEL, (_e, open: boolean) =>
    tabs.setSidePanelOpen(Boolean(open))
  )
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SET_MODAL_OPEN, (_e, open: boolean) =>
    tabs.setModalOpen(Boolean(open))
  )

  // Adblock Shield
  ipcMain.handle(IPC_CHANNELS.ADBLOCK_TOGGLE_GLOBAL, () => {
    const next = !db.getSettings().adblockEnabled
    db.updateSettings({ adblockEnabled: next })
    return next
  })
  ipcMain.handle(IPC_CHANNELS.ADBLOCK_TOGGLE_DOMAIN, (_e, urlOrHost: string) => {
    const res = adblock.toggleDomainWhitelist(urlOrHost)
    tabs.refreshWhitelistStates()
    return res
  })
  ipcMain.handle(IPC_CHANNELS.ADBLOCK_GET_STATUS, () => {
    const s = db.getSettings()
    return { enabled: s.adblockEnabled, whitelistedDomains: s.whitelistedDomains }
  })

  // Media Sniffer & Extractor
  ipcMain.handle(IPC_CHANNELS.MEDIA_GET_FOR_TAB, (_e, tabId: string) =>
    snifferManager.getMediaForTab(tabId)
  )
  ipcMain.handle(IPC_CHANNELS.MEDIA_CLEAR_FOR_TAB, (_e, tabId: string) =>
    snifferManager.clearMediaForTab(tabId)
  )
  ipcMain.handle(IPC_CHANNELS.MEDIA_DEEP_ANALYZE_YTDLP, (_e, tabId: string) =>
    snifferManager.deepAnalyzeWithYtDlp(tabId)
  )

  // Headless Paste-URL Sniffer
  ipcMain.handle(IPC_CHANNELS.HEADLESS_START_PROBE, (_e, url: string) =>
    headlessSniffer.startProbe(url)
  )
  ipcMain.handle(IPC_CHANNELS.HEADLESS_CANCEL_PROBE, (_e, jobId: string) =>
    headlessSniffer.cancelProbe(jobId)
  )
  ipcMain.handle(IPC_CHANNELS.HEADLESS_GET_JOBS, () => headlessSniffer.getJobs())

  // Downloads
  ipcMain.handle(
    IPC_CHANNELS.DOWNLOADS_START_FROM_MEDIA,
    (_e, media: DetectedMedia, selection: TrackSelection) =>
      orchestrator.startFromDetectedMedia(media, selection)
  )
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_GET_ALL, () => orchestrator.getAllTasks())
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_PAUSE, (_e, id: string) => orchestrator.pauseTask(id))
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_RESUME, (_e, id: string) => orchestrator.resumeTask(id))
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_CANCEL, (_e, id: string) => orchestrator.cancelTask(id))
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_DELETE, (_e, id: string, delFile?: boolean) =>
    orchestrator.deleteTask(id, delFile)
  )
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_OPEN_FILE, (_e, id: string) => orchestrator.openFile(id))
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_SHOW_IN_FOLDER, (_e, id: string) =>
    orchestrator.showInFolder(id)
  )
  ipcMain.handle(IPC_CHANNELS.DOWNLOADS_CLEAR_COMPLETED, () => orchestrator.clearCompleted())

  // Bookmarks & History
  ipcMain.handle(IPC_CHANNELS.BOOKMARKS_LIST, () => db.listBookmarks())
  ipcMain.handle(IPC_CHANNELS.BOOKMARKS_ADD, (_e, item) => db.addBookmark(item))
  ipcMain.handle(IPC_CHANNELS.BOOKMARKS_REMOVE, (_e, idOrUrl: string) => db.removeBookmark(idOrUrl))
  ipcMain.handle(IPC_CHANNELS.HISTORY_LIST, (_e, query?: string) => db.listHistory(query))
  ipcMain.handle(IPC_CHANNELS.HISTORY_CLEAR, () => db.clearHistory())
  ipcMain.handle(IPC_CHANNELS.HISTORY_DELETE_ITEM, (_e, id: string) => db.deleteHistoryItem(id))

  // Settings & Portable Binaries
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => db.getSettings())
  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, (_e, partial: Partial<AppSettings>) =>
    db.updateSettings(partial)
  )
  ipcMain.handle(IPC_CHANNELS.SETTINGS_PICK_FOLDER, async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Default Download Folder',
      defaultPath: db.getSettings().downloadDir,
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.BINARIES_CHECK_HEALTH, () => binaries.checkHealth())
  ipcMain.handle(IPC_CHANNELS.BINARIES_INSTALL_UPDATE, (_e, force?: boolean) =>
    binaries.installOrUpdateBinaries(
      (msg) => sendToShell(IPC_CHANNELS.BINARIES_PROGRESS, msg),
      Boolean(force)
    )
  )

  // Diagnostic Flight-Recorder Controls
  diagLogger.init()
  ipcMain.handle(IPC_CHANNELS.DIAG_GET_STATUS, () => diagLogger.getStatus())
  ipcMain.handle(IPC_CHANNELS.DIAG_CLEAR_LOGS, () => diagLogger.clearLogs())
  ipcMain.handle(IPC_CHANNELS.DIAG_OPEN_LOGS_FOLDER, () => {
    const paths = resolvePortablePaths()
    return shell.openPath(paths.logsDir)
  })
}

void app.whenReady().then(bootstrapApplication)

app.on('before-quit', () => {
  dbService?.close()
})

app.on('window-all-closed', () => {
  app.quit()
})
