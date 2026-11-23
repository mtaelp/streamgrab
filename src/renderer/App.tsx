import React, { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { BrowserToolbar } from './components/Toolbar/BrowserToolbar'
import { SidePanel } from './components/SidePanel/SidePanel'
import { NewTabView } from './components/Views/NewTabView'
import { DownloadsView } from './components/Views/DownloadsView'
import { HistoryBookmarksView } from './components/Views/HistoryBookmarksView'
import { SettingsView } from './components/Views/SettingsView'

export const App: React.FC = () => {
  const initialize = useAppStore((s) => s.initialize)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const toastMessage = useAppStore((s) => s.toastMessage)
  const lastBlockedPopup = useAppStore((s) => s.lastBlockedPopup)
  const showToast = useAppStore((s) => s.showToast)

  useEffect(() => {
    void initialize()
  }, [initialize])

  const activeTab = tabs.find((t) => t.id === activeTabId) || null
  const internalRoute = activeTab ? activeTab.internalRoute : 'newtab'

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-950 text-zinc-100 overflow-hidden">
      <BrowserToolbar />

      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {/* Main Viewport Area: WebContentsView overlays here when internalRoute === null */}
        <main className="flex-1 min-w-0 h-full bg-zinc-950">
          {internalRoute === 'newtab' && <NewTabView />}
          {internalRoute === 'downloads' && <DownloadsView />}
          {internalRoute === 'bookmarks' && <HistoryBookmarksView initialMode="bookmarks" />}
          {internalRoute === 'history' && <HistoryBookmarksView initialMode="history" />}
          {internalRoute === 'settings' && <SettingsView />}
          {internalRoute === null && (
            <div className="flex h-full w-full items-center justify-center text-xs text-zinc-600">
              Loading browser viewport...
            </div>
          )}
        </main>

        {/* Collapsible 420px Right Side-Panel */}
        <SidePanel />

        {/* Status Toast */}
        {toastMessage && (
          <div className="fixed right-4 top-24 z-50 flex max-w-md items-center gap-3 rounded-xl border border-emerald-500/40 bg-zinc-900/95 px-4 py-2.5 text-xs font-medium text-emerald-200 shadow-xl">
            <span className="truncate">{toastMessage}</span>
            {lastBlockedPopup && (
              <button
                type="button"
                onClick={() => {
                  void window.streamgrab.tabs.create({
                    url: lastBlockedPopup.url,
                    isIncognito: lastBlockedPopup.isIncognito,
                    activate: true
                  })
                  showToast('Opened link in new tab', null)
                }}
                className="shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-100 hover:bg-zinc-700"
              >
                Open Tab
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
