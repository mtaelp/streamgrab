import React, { useState } from 'react'
import { Bookmark, Download, EyeOff, Film, Globe, ShieldCheck, Zap } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'

const TEST_STREAMS = [
  {
    title: 'Akamai HLS Test Player',
    subtitle: 'Adaptive HLS (.m3u8) multi-bitrate test',
    url: 'https://players.akamai.com/players/hlsjs'
  },
  {
    title: 'DASH-IF Reference Client',
    subtitle: 'MPEG-DASH (.mpd) split video/audio test',
    url: 'https://reference.dashif.org/dash.js/latest/samples/dash-if-reference-player/index.html'
  },
  {
    title: 'YouTube',
    subtitle: 'Extractor + live session cookies',
    url: 'https://www.youtube.com'
  },
  {
    title: 'Vimeo Watch',
    subtitle: 'HLS + DASH + Extractor support',
    url: 'https://vimeo.com/watch'
  }
]

export const NewTabView: React.FC = () => {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const downloads = useAppStore((s) => s.downloads)
  const openSidePanel = useAppStore((s) => s.openSidePanel)

  const [query, setQuery] = useState('')
  const [headlessUrl, setHeadlessUrl] = useState('')

  const handleBrowse = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!activeTabId || !query.trim()) return
    void window.streamgrab.tabs.navigate(activeTabId, query.trim())
  }

  const handleQuickSniff = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!headlessUrl.trim()) return
    const target = headlessUrl.trim()
    setHeadlessUrl('')
    openSidePanel('sniff')
    await window.streamgrab.headless.startProbe(target)
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 p-8">
      <div className="mx-auto max-w-4xl space-y-8 pt-6">
        {/* Hero Header */}
        <div className="text-center space-y-2">
          <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1 text-xs font-medium text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            100% Portable Browser • Dual-Layer Sniffer • Power Trio Engine
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">StreamGrab Browser</h1>
          <p className="text-sm text-zinc-400">
            Browse ad-free, intercept HLS / DASH / Blob / iframe streams in real time, and mux at
            32-thread native speed.
          </p>
        </div>

        {/* Main Browse / Search Input */}
        <form onSubmit={handleBrowse} className="mx-auto max-w-2xl">
          <div className="flex items-center rounded-2xl border border-zinc-800 bg-zinc-900/90 p-1.5 shadow-lg focus-within:border-emerald-500">
            <Globe className="ml-3 h-5 w-5 text-zinc-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Enter any video website URL or search..."
              className="flex-1 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              Open Page
            </button>
          </div>
        </form>

        {/* Quick Paste-URL Headless Sniffer Card */}
        <div className="mx-auto max-w-2xl rounded-2xl border border-amber-500/25 bg-zinc-900/70 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-300 mb-2">
            <Zap className="h-4 w-4 text-amber-400" />
            Paste-URL Headless Sniffer (No Manual Browsing Required)
          </div>
          <form onSubmit={(e) => void handleQuickSniff(e)} className="flex gap-2">
            <input
              type="text"
              value={headlessUrl}
              onChange={(e) => setHeadlessUrl(e.target.value)}
              placeholder="Paste a page link to auto-sniff in a hidden muted tab..."
              className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
            >
              Auto-Sniff
            </button>
          </form>
        </div>

        {/* Quick Launchers & Stream Test Targets */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <Film className="h-4 w-4 text-emerald-400" /> Quick Stream Targets
              </h2>
              <button
                type="button"
                onClick={() =>
                  void window.streamgrab.tabs.create({ isIncognito: true, activate: true })
                }
                className="flex items-center gap-1 text-xs text-purple-300 hover:underline"
              >
                <EyeOff className="h-3.5 w-3.5" /> Open Private Tab
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TEST_STREAMS.map((item) => (
                <button
                  key={item.url}
                  type="button"
                  onClick={() =>
                    activeTabId && void window.streamgrab.tabs.navigate(activeTabId, item.url)
                  }
                  className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-left transition hover:border-emerald-500/50 hover:bg-zinc-900"
                >
                  <p className="text-xs font-semibold text-zinc-100">{item.title}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">{item.subtitle}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Saved Bookmarks & Downloads Summary */}
          <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <Bookmark className="h-4 w-4 text-amber-400" /> Saved Bookmarks ({bookmarks.length})
              </h2>
              <button
                type="button"
                onClick={() => void window.streamgrab.tabs.openInternal(null, 'downloads')}
                className="flex items-center gap-1 text-xs text-cyan-400 hover:underline"
              >
                <Download className="h-3.5 w-3.5" /> Downloads ({downloads.length})
              </button>
            </div>

            {bookmarks.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500">
                Bookmarked sites appear here for instant 1-click access.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {bookmarks.slice(0, 6).map((bm) => (
                  <button
                    key={bm.id}
                    type="button"
                    onClick={() =>
                      activeTabId && void window.streamgrab.tabs.navigate(activeTabId, bm.url)
                    }
                    className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5 text-left hover:border-zinc-700"
                  >
                    <p className="truncate text-xs font-medium text-zinc-100">{bm.title}</p>
                    <p className="truncate text-[11px] text-zinc-500">{bm.url}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
