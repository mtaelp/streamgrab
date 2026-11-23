import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type {
  AppSettings,
  BinaryHealthReport,
  BookmarkItem,
  DetectedMedia,
  DownloadTask,
  HeadlessProbeJob,
  HistoryItem,
  InternalRoute,
  TabState,
  TrackSelection
} from '@shared/types'

export interface StreamGrabRendererApi {
  tabs: {
    getState: () => Promise<{ tabs: TabState[]; activeTabId: string | null }>
    create: (opts?: {
      url?: string
      isIncognito?: boolean
      activate?: boolean
      internalRoute?: InternalRoute
    }) => Promise<TabState>
    close: (tabId: string) => Promise<void>
    activate: (tabId: string) => Promise<void>
    navigate: (tabId: string, input: string) => Promise<void>
    goBack: (tabId: string) => Promise<void>
    goForward: (tabId: string) => Promise<void>
    reload: (tabId: string) => Promise<void>
    toggleMute: (tabId: string) => Promise<void>
    openInternal: (tabId: string | null, route: Exclude<InternalRoute, null>) => Promise<void>
    onUpdated: (
      cb: (payload: { tabs: TabState[]; activeTabId: string | null }) => void
    ) => () => void
  }
  layout: {
    setSidePanelOpen: (open: boolean) => Promise<void>
    setModalOpen: (open: boolean) => Promise<void>
  }
  adblock: {
    toggleGlobal: () => Promise<boolean>
    toggleDomain: (urlOrHost: string) => Promise<{ whitelisted: boolean; domain: string }>
    getStatus: () => Promise<{ enabled: boolean; whitelistedDomains: string[] }>
    onPopupBlocked: (cb: (payload: { url: string; isIncognito: boolean }) => void) => () => void
  }
  media: {
    getForTab: (tabId: string) => Promise<DetectedMedia[]>
    clearForTab: (tabId: string) => Promise<void>
    deepAnalyzeWithYtDlp: (tabId: string) => Promise<DetectedMedia | null>
    onUpdated: (
      cb: (payload: { tabId: string; media: DetectedMedia[] }) => void
    ) => () => void
  }
  headless: {
    startProbe: (url: string) => Promise<HeadlessProbeJob>
    cancelProbe: (jobId: string) => Promise<void>
    getJobs: () => Promise<HeadlessProbeJob[]>
    onUpdated: (cb: (jobs: HeadlessProbeJob[]) => void) => () => void
  }
  downloads: {
    startFromMedia: (media: DetectedMedia, selection: TrackSelection) => Promise<DownloadTask>
    getAll: () => Promise<DownloadTask[]>
    pause: (taskId: string) => Promise<void>
    resume: (taskId: string) => Promise<void>
    cancel: (taskId: string) => Promise<void>
    delete: (taskId: string, deleteFile?: boolean) => Promise<void>
    openFile: (taskId: string) => Promise<void>
    showInFolder: (taskId: string) => Promise<void>
    clearCompleted: () => Promise<void>
    onUpdated: (cb: (tasks: DownloadTask[]) => void) => () => void
  }
  bookmarks: {
    list: () => Promise<BookmarkItem[]>
    add: (item: { url: string; title: string; favicon?: string; folder?: string }) => Promise<BookmarkItem>
    remove: (idOrUrl: string) => Promise<void>
  }
  history: {
    list: (query?: string) => Promise<HistoryItem[]>
    clear: () => Promise<void>
    deleteItem: (id: string) => Promise<void>
  }
  settings: {
    get: () => Promise<AppSettings>
    update: (partial: Partial<AppSettings>) => Promise<AppSettings>
    pickFolder: () => Promise<string | null>
  }
  binaries: {
    checkHealth: () => Promise<BinaryHealthReport>
    installOrUpdate: (force?: boolean) => Promise<BinaryHealthReport>
    onProgress: (cb: (msg: string) => void) => () => void
  }
  diag: {
    getStatus: () => Promise<{ jsonlPath: string; readablePath: string; eventCount: number }>
    clearLogs: () => Promise<{ jsonlPath: string; eventCount: number }>
    openLogsFolder: () => Promise<string>
  }
}

function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, data: T): void => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StreamGrabRendererApi = {
  tabs: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.TABS_GET_STATE),
    create: (opts) => ipcRenderer.invoke(IPC_CHANNELS.TABS_CREATE, opts),
    close: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TABS_CLOSE, tabId),
    activate: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TABS_ACTIVATE, tabId),
    navigate: (tabId, input) => ipcRenderer.invoke(IPC_CHANNELS.TABS_NAVIGATE, tabId, input),
    goBack: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TABS_GO_BACK, tabId),
    goForward: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TABS_GO_FORWARD, tabId),
    reload: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TABS_RELOAD, tabId),
    toggleMute: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.TABS_TOGGLE_MUTE, tabId),
    openInternal: (tabId, route) => ipcRenderer.invoke(IPC_CHANNELS.TABS_OPEN_INTERNAL, tabId, route),
    onUpdated: (cb) => subscribe(IPC_CHANNELS.TABS_UPDATED, cb)
  },
  layout: {
    setSidePanelOpen: (open) => ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SET_SIDE_PANEL, open),
    setModalOpen: (open) => ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SET_MODAL_OPEN, open)
  },
  adblock: {
    toggleGlobal: () => ipcRenderer.invoke(IPC_CHANNELS.ADBLOCK_TOGGLE_GLOBAL),
    toggleDomain: (urlOrHost) => ipcRenderer.invoke(IPC_CHANNELS.ADBLOCK_TOGGLE_DOMAIN, urlOrHost),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.ADBLOCK_GET_STATUS),
    onPopupBlocked: (cb) => subscribe(IPC_CHANNELS.POPUP_BLOCKED_EVENT, cb)
  },
  media: {
    getForTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_GET_FOR_TAB, tabId),
    clearForTab: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_CLEAR_FOR_TAB, tabId),
    deepAnalyzeWithYtDlp: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.MEDIA_DEEP_ANALYZE_YTDLP, tabId),
    onUpdated: (cb) => subscribe(IPC_CHANNELS.MEDIA_UPDATED, cb)
  },
  headless: {
    startProbe: (url) => ipcRenderer.invoke(IPC_CHANNELS.HEADLESS_START_PROBE, url),
    cancelProbe: (jobId) => ipcRenderer.invoke(IPC_CHANNELS.HEADLESS_CANCEL_PROBE, jobId),
    getJobs: () => ipcRenderer.invoke(IPC_CHANNELS.HEADLESS_GET_JOBS),
    onUpdated: (cb) => subscribe(IPC_CHANNELS.HEADLESS_UPDATED, cb)
  },
  downloads: {
    startFromMedia: (media, selection) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_START_FROM_MEDIA, media, selection),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_GET_ALL),
    pause: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_PAUSE, taskId),
    resume: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_RESUME, taskId),
    cancel: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_CANCEL, taskId),
    delete: (taskId, deleteFile) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_DELETE, taskId, deleteFile),
    openFile: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_OPEN_FILE, taskId),
    showInFolder: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_SHOW_IN_FOLDER, taskId),
    clearCompleted: () => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOADS_CLEAR_COMPLETED),
    onUpdated: (cb) => subscribe(IPC_CHANNELS.DOWNLOADS_UPDATED, cb)
  },
  bookmarks: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARKS_LIST),
    add: (item) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARKS_ADD, item),
    remove: (idOrUrl) => ipcRenderer.invoke(IPC_CHANNELS.BOOKMARKS_REMOVE, idOrUrl)
  },
  history: {
    list: (query) => ipcRenderer.invoke(IPC_CHANNELS.HISTORY_LIST, query),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.HISTORY_CLEAR),
    deleteItem: (id) => ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE_ITEM, id)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (partial) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, partial),
    pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_PICK_FOLDER)
  },
  binaries: {
    checkHealth: () => ipcRenderer.invoke(IPC_CHANNELS.BINARIES_CHECK_HEALTH),
    installOrUpdate: (force) => ipcRenderer.invoke(IPC_CHANNELS.BINARIES_INSTALL_UPDATE, force),
    onProgress: (cb) => subscribe(IPC_CHANNELS.BINARIES_PROGRESS, cb)
  },
  diag: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.DIAG_GET_STATUS),
    clearLogs: () => ipcRenderer.invoke(IPC_CHANNELS.DIAG_CLEAR_LOGS),
    openLogsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.DIAG_OPEN_LOGS_FOLDER)
  }
}

contextBridge.exposeInMainWorld('streamgrab', api)
