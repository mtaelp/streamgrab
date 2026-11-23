import { create } from 'zustand'
import type {
  AppSettings,
  BinaryHealthReport,
  BookmarkItem,
  DetectedMedia,
  DownloadTask,
  HeadlessProbeJob,
  HistoryItem,
  SidePanelTab,
  TabState,
  TrackSelection
} from '@shared/types'

interface AppStoreState {
  tabs: TabState[]
  activeTabId: string | null
  mediaByTabId: Record<string, DetectedMedia[]>
  downloads: DownloadTask[]
  headlessJobs: HeadlessProbeJob[]
  bookmarks: BookmarkItem[]
  history: HistoryItem[]
  settings: AppSettings | null
  binaryHealth: BinaryHealthReport | null
  binaryProgressMsg: string | null

  isSidePanelOpen: boolean
  sidePanelTab: SidePanelTab
  isAnalyzingYtDlp: boolean
  toastMessage: string | null
  lastBlockedPopup: { url: string; isIncognito: boolean } | null

  initialize: () => Promise<void>
  openSidePanel: (tab: SidePanelTab) => void
  toggleSidePanel: (tab?: SidePanelTab) => void
  closeSidePanel: () => void
  showToast: (msg: string, blockedPopup?: { url: string; isIncognito: boolean } | null) => void

  refreshBookmarks: () => Promise<void>
  refreshHistory: (query?: string) => Promise<void>
  refreshSettings: () => Promise<void>
  refreshBinaries: () => Promise<void>

  triggerDeepYtDlpScan: (tabId: string) => Promise<void>
  startDownload: (media: DetectedMedia, selection: TrackSelection) => Promise<void>
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useAppStore = create<AppStoreState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  mediaByTabId: {},
  downloads: [],
  headlessJobs: [],
  bookmarks: [],
  history: [],
  settings: null,
  binaryHealth: null,
  binaryProgressMsg: null,

  isSidePanelOpen: false,
  sidePanelTab: 'media',
  isAnalyzingYtDlp: false,
  toastMessage: null,
  lastBlockedPopup: null,

  showToast: (msg: string, blockedPopup: { url: string; isIncognito: boolean } | null = null) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toastMessage: msg, lastBlockedPopup: blockedPopup })
    toastTimer = setTimeout(() => {
      set({ toastMessage: null, lastBlockedPopup: null })
    }, 4000)
  },

  openSidePanel: (tab: SidePanelTab) => {
    set({ isSidePanelOpen: true, sidePanelTab: tab })
    void window.streamgrab.layout.setSidePanelOpen(true)
  },

  toggleSidePanel: (tab?: SidePanelTab) => {
    const { isSidePanelOpen, sidePanelTab } = get()
    if (!isSidePanelOpen) {
      set({ isSidePanelOpen: true, sidePanelTab: tab || sidePanelTab })
      void window.streamgrab.layout.setSidePanelOpen(true)
    } else if (tab && tab !== sidePanelTab) {
      set({ sidePanelTab: tab })
    } else {
      set({ isSidePanelOpen: false })
      void window.streamgrab.layout.setSidePanelOpen(false)
    }
  },

  closeSidePanel: () => {
    set({ isSidePanelOpen: false })
    void window.streamgrab.layout.setSidePanelOpen(false)
  },

  initialize: async () => {
    const [tabSnap, dlList, jobs, bms, settings, binHealth] = await Promise.all([
      window.streamgrab.tabs.getState(),
      window.streamgrab.downloads.getAll(),
      window.streamgrab.headless.getJobs(),
      window.streamgrab.bookmarks.list(),
      window.streamgrab.settings.get(),
      window.streamgrab.binaries.checkHealth()
    ])

    const mediaMap: Record<string, DetectedMedia[]> = {}
    if (tabSnap.activeTabId) {
      mediaMap[tabSnap.activeTabId] = await window.streamgrab.media.getForTab(tabSnap.activeTabId)
    }

    set({
      tabs: tabSnap.tabs,
      activeTabId: tabSnap.activeTabId,
      mediaByTabId: mediaMap,
      downloads: dlList,
      headlessJobs: jobs,
      bookmarks: bms,
      settings,
      binaryHealth: binHealth
    })

    window.streamgrab.tabs.onUpdated(async (payload) => {
      set({ tabs: payload.tabs, activeTabId: payload.activeTabId })
      if (payload.activeTabId && !get().mediaByTabId[payload.activeTabId]) {
        const list = await window.streamgrab.media.getForTab(payload.activeTabId)
        set((s) => ({
          mediaByTabId: { ...s.mediaByTabId, [payload.activeTabId!]: list }
        }))
      }
    })

    window.streamgrab.media.onUpdated(({ tabId, media }) => {
      set((s) => ({
        mediaByTabId: { ...s.mediaByTabId, [tabId]: media }
      }))
    })

    window.streamgrab.downloads.onUpdated((tasks) => {
      const prevLen = get().downloads.length
      set({ downloads: tasks })
      // Auto-open Downloads side-panel when a browser file download is intercepted
      if (tasks.length > prevLen && !get().isSidePanelOpen) {
        get().openSidePanel('downloads')
      }
    })

    window.streamgrab.headless.onUpdated((jobs) => {
      set({ headlessJobs: jobs })
    })

    window.streamgrab.binaries.onProgress((msg) => {
      set({ binaryProgressMsg: msg })
    })

    window.streamgrab.adblock.onPopupBlocked(({ url, isIncognito }) => {
      try {
        const host = url.startsWith('http') ? new URL(url).hostname : 'ad popup'
        get().showToast(`🛡️ Blocked popup (${host})`, url.startsWith('http') ? { url, isIncognito } : null)
      } catch {
        get().showToast('🛡️ Blocked popup ad', null)
      }
    })
  },

  refreshBookmarks: async () => {
    const bookmarks = await window.streamgrab.bookmarks.list()
    set({ bookmarks })
  },

  refreshHistory: async (query?: string) => {
    const history = await window.streamgrab.history.list(query)
    set({ history })
  },

  refreshSettings: async () => {
    const settings = await window.streamgrab.settings.get()
    set({ settings })
  },

  refreshBinaries: async () => {
    const binaryHealth = await window.streamgrab.binaries.checkHealth()
    set({ binaryHealth })
  },

  triggerDeepYtDlpScan: async (tabId: string) => {
    set({ isAnalyzingYtDlp: true })
    try {
      const res = await window.streamgrab.media.deepAnalyzeWithYtDlp(tabId)
      if (res) {
        get().showToast(`Extractor found "${res.title}" (${res.videoTracks.length} qualities)`)
      } else {
        get().showToast('No additional yt-dlp extractor streams found on this page')
      }
    } finally {
      set({ isAnalyzingYtDlp: false })
    }
  },

  startDownload: async (media: DetectedMedia, selection: TrackSelection) => {
    try {
      const task = await window.streamgrab.downloads.startFromMedia(media, selection)
      get().showToast(`Started downloading: ${task.filename}`)
      get().openSidePanel('downloads')
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : 'Failed to start download')
    }
  }
}))
