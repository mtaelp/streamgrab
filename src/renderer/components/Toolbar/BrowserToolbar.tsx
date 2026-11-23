import React, { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Bug,
  Download,
  EyeOff,
  Film,
  Globe,
  History,
  Home,
  Loader2,
  Plus,
  RotateCw,
  Settings,
  Shield,
  ShieldOff,
  Volume2,
  VolumeX,
  X,
  Zap
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { formatSpeed } from '../../utils/format'

export const BrowserToolbar: React.FC = () => {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const downloads = useAppStore((s) => s.downloads)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const settings = useAppStore((s) => s.settings)
  const isSidePanelOpen = useAppStore((s) => s.isSidePanelOpen)
  const sidePanelTab = useAppStore((s) => s.sidePanelTab)
  const toggleSidePanel = useAppStore((s) => s.toggleSidePanel)
  const refreshBookmarks = useAppStore((s) => s.refreshBookmarks)
  const refreshSettings = useAppStore((s) => s.refreshSettings)
  const showToast = useAppStore((s) => s.showToast)

  const activeTab = tabs.find((t) => t.id === activeTabId) || null
  const [addressInput, setAddressInput] = useState('')

  useEffect(() => {
    if (!activeTab) return
    if (activeTab.internalRoute === 'newtab') {
      setAddressInput('')
    } else {
      setAddressInput(activeTab.url)
    }
  }, [activeTab?.id, activeTab?.url, activeTab?.internalRoute])

  const activeDownloads = downloads.filter(
    (d) =>
      d.status === 'downloading' ||
      d.status === 'muxing' ||
      d.status === 'refreshing_token' ||
      d.status === 'queued'
  )
  const totalSpeedBps = activeDownloads.reduce((acc, d) => acc + (d.speedBps || 0), 0)

  const isBookmarked = Boolean(
    activeTab &&
      !activeTab.internalRoute &&
      bookmarks.some((b) => b.url === activeTab.url)
  )

  const handleAddressSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!activeTabId || !addressInput.trim()) return
    void window.streamgrab.tabs.navigate(activeTabId, addressInput.trim())
  }

  const handleToggleBookmark = async (): Promise<void> => {
    if (!activeTab || activeTab.internalRoute) return
    if (isBookmarked) {
      await window.streamgrab.bookmarks.remove(activeTab.url)
      showToast('Removed from Bookmarks')
    } else {
      await window.streamgrab.bookmarks.add({
        url: activeTab.url,
        title: activeTab.title,
        favicon: activeTab.favicon
      })
      showToast('Saved to Bookmarks')
    }
    await refreshBookmarks()
  }

  const handleShieldClick = async (): Promise<void> => {
    if (!activeTab || activeTab.internalRoute) {
      const enabled = await window.streamgrab.adblock.toggleGlobal()
      await refreshSettings()
      showToast(enabled ? 'Global Adblock Enabled' : 'Global Adblock Paused')
      return
    }
    const res = await window.streamgrab.adblock.toggleDomain(activeTab.url)
    await refreshSettings()
    if (res.domain) {
      showToast(
        res.whitelisted
          ? `Paused Adblock on ${res.domain} (reload page to apply)`
          : `Re-enabled Adblock on ${res.domain}`
      )
      void window.streamgrab.tabs.reload(activeTab.id)
    }
  }

  const shieldActive =
    Boolean(settings?.adblockEnabled) && !Boolean(activeTab?.isSiteWhitelisted)

  return (
    <header className="h-[88px] w-full shrink-0 border-b border-zinc-800 bg-zinc-950 flex flex-col justify-between">
      {/* Row 1: Tab Strip (40px) */}
      <div className="flex h-10 items-center gap-1 px-2 pt-1 bg-zinc-950 overflow-x-auto">
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                onClick={() => void window.streamgrab.tabs.activate(tab.id)}
                className={`group flex h-8 max-w-[220px] min-w-[130px] cursor-pointer items-center gap-2 rounded-t-lg border-x border-t px-2.5 text-xs transition ${
                  isActive
                    ? tab.isIncognito
                      ? 'border-purple-500/40 bg-purple-950/50 text-purple-100'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-100'
                    : 'border-transparent bg-zinc-950/60 text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
                }`}
              >
                {tab.isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-400" />
                ) : tab.isIncognito ? (
                  <EyeOff className="h-3.5 w-3.5 shrink-0 text-purple-400" />
                ) : tab.favicon ? (
                  <img src={tab.favicon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
                ) : (
                  <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                )}

                <span className="flex-1 truncate">{tab.title || 'New Tab'}</span>

                {/* Audio Mute Indicator */}
                {(tab.isAudible || tab.isMuted) && (
                  <button
                    type="button"
                    title={tab.isMuted ? 'Unmute Tab' : 'Mute Tab'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.streamgrab.tabs.toggleMute(tab.id)
                    }}
                    className="rounded p-0.5 hover:bg-zinc-800"
                  >
                    {tab.isMuted ? (
                      <VolumeX className="h-3 w-3 text-rose-400" />
                    ) : (
                      <Volume2 className="h-3 w-3 text-emerald-400" />
                    )}
                  </button>
                )}

                {/* Per-tab detected streams pill */}
                {tab.detectedMediaCount > 0 && (
                  <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
                    {tab.detectedMediaCount}
                  </span>
                )}

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    void window.streamgrab.tabs.close(tab.id)
                  }}
                  className="rounded p-0.5 opacity-60 hover:bg-zinc-800 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}

          <button
            type="button"
            title="New Tab (Ctrl+T)"
            onClick={() => void window.streamgrab.tabs.create({ activate: true })}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Plus className="h-4 w-4" />
          </button>

          <button
            type="button"
            title="New Private / Incognito Tab (Ctrl+Shift+N)"
            onClick={() =>
              void window.streamgrab.tabs.create({ isIncognito: true, activate: true })
            }
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-purple-300/80 hover:bg-purple-950/60 hover:text-purple-200"
          >
            <EyeOff className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Private</span>
          </button>
        </div>

        {/* Right Quick Internal Page Shortcuts */}
        <div className="flex shrink-0 items-center gap-1 pl-2">
          <button
            type="button"
            title="Clear Flight-Recorder Debug Log (Click right before testing a page!)"
            onClick={() =>
              void window.streamgrab.diag.clearLogs().then((res) => {
                showToast(`🐞 Debug log cleared — recording fresh events to ${res.jsonlPath}`)
              })
            }
            className="flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20"
          >
            <Bug className="h-3 w-3" />
            <span>Reset Debug Log</span>
          </button>
          <button
            type="button"
            title="Full Downloads Manager"
            onClick={() => void window.streamgrab.tabs.openInternal(null, 'downloads')}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="History & Bookmarks"
            onClick={() => void window.streamgrab.tabs.openInternal(null, 'history')}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <History className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Settings & Portable Tools"
            onClick={() => void window.streamgrab.tabs.openInternal(null, 'settings')}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Row 2: Navigation, Omnibox & Sniffer Action Badges (48px) */}
      <div className="flex h-12 items-center gap-2 bg-zinc-900 px-3">
        {/* Nav Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!activeTab?.canGoBack}
            onClick={() => activeTabId && void window.streamgrab.tabs.goBack(activeTabId)}
            className="rounded-lg p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!activeTab?.canGoForward}
            onClick={() => activeTabId && void window.streamgrab.tabs.goForward(activeTabId)}
            className="rounded-lg p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
          >
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => activeTabId && void window.streamgrab.tabs.reload(activeTabId)}
            className="rounded-lg p-1.5 text-zinc-300 hover:bg-zinc-800"
          >
            <RotateCw className={`h-4 w-4 ${activeTab?.isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            title="Start Page"
            onClick={() =>
              activeTabId && void window.streamgrab.tabs.openInternal(activeTabId, 'newtab')
            }
            className="rounded-lg p-1.5 text-zinc-300 hover:bg-zinc-800"
          >
            <Home className="h-4 w-4" />
          </button>
        </div>

        {/* Omnibox */}
        <form onSubmit={handleAddressSubmit} className="relative flex flex-1 items-center">
          <input
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Enter website URL, video stream link, or search..."
            className="h-8 w-full rounded-full border border-zinc-700/80 bg-zinc-950 pl-4 pr-9 text-xs text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          {activeTab && !activeTab.internalRoute && (
            <button
              type="button"
              title={isBookmarked ? 'Remove Bookmark' : 'Bookmark This Page'}
              onClick={() => void handleToggleBookmark()}
              className="absolute right-2.5 rounded p-1 text-zinc-400 hover:text-amber-400"
            >
              <Bookmark
                className={`h-3.5 w-3.5 ${isBookmarked ? 'fill-amber-400 text-amber-400' : ''}`}
              />
            </button>
          )}
        </form>

        {/* Action Badges */}
        <div className="flex items-center gap-1.5">
          {/* Paste-URL Headless Sniffer */}
          <button
            type="button"
            title="Paste URL Headless Sniffer (Auto-sniff in hidden muted tab)"
            onClick={() => toggleSidePanel('sniff')}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
              isSidePanelOpen && sidePanelTab === 'sniff'
                ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                : 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <Zap className="h-3.5 w-3.5 text-amber-400" />
            <span className="hidden md:inline">Paste & Sniff</span>
          </button>

          {/* Adblock Shield */}
          <button
            type="button"
            title={
              shieldActive
                ? 'Adblock Shield Active (Click to pause on this site)'
                : 'Adblock Paused on this site (Click to re-enable)'
            }
            onClick={() => void handleShieldClick()}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
              shieldActive
                ? 'border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                : 'border-zinc-800 bg-zinc-950 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {shieldActive ? (
              <Shield className="h-3.5 w-3.5 text-sky-400" />
            ) : (
              <ShieldOff className="h-3.5 w-3.5" />
            )}
            <span>{activeTab?.blockedAdsCount || 0}</span>
          </button>

          {/* Detected Media Badge */}
          <button
            type="button"
            title="Detected Video & Audio Streams"
            onClick={() => toggleSidePanel('media')}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition ${
              (activeTab?.detectedMediaCount || 0) > 0
                ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.25)]'
                : isSidePanelOpen && sidePanelTab === 'media'
                  ? 'border-zinc-700 bg-zinc-800 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Film
              className={`h-3.5 w-3.5 ${
                (activeTab?.detectedMediaCount || 0) > 0 ? 'text-emerald-400 animate-pulse' : ''
              }`}
            />
            <span>Grab ({activeTab?.detectedMediaCount || 0})</span>
          </button>

          {/* Live Downloads Side-Panel Button */}
          <button
            type="button"
            title="Active Downloads"
            onClick={() => toggleSidePanel('downloads')}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
              activeDownloads.length > 0
                ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-300'
                : isSidePanelOpen && sidePanelTab === 'downloads'
                  ? 'border-zinc-700 bg-zinc-800 text-zinc-100'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Download className="h-3.5 w-3.5" />
            <span>
              {activeDownloads.length > 0
                ? `${activeDownloads.length} • ${formatSpeed(totalSpeedBps)}`
                : downloads.length}
            </span>
          </button>
        </div>
      </div>
    </header>
  )
}
