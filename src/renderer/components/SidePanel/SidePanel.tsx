import React, { useState } from 'react'
import {
  Bookmark,
  Download,
  ExternalLink,
  Film,
  Loader2,
  Sparkles,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { StreamCard } from '../Media/StreamCard'
import { DownloadItemCard } from '../Downloads/DownloadItemCard'

export const SidePanel: React.FC = () => {
  const isSidePanelOpen = useAppStore((s) => s.isSidePanelOpen)
  const sidePanelTab = useAppStore((s) => s.sidePanelTab)
  const openSidePanel = useAppStore((s) => s.openSidePanel)
  const closeSidePanel = useAppStore((s) => s.closeSidePanel)

  const activeTabId = useAppStore((s) => s.activeTabId)
  const tabs = useAppStore((s) => s.tabs)
  const mediaByTabId = useAppStore((s) => s.mediaByTabId)
  const downloads = useAppStore((s) => s.downloads)
  const headlessJobs = useAppStore((s) => s.headlessJobs)
  const bookmarks = useAppStore((s) => s.bookmarks)
  const isAnalyzingYtDlp = useAppStore((s) => s.isAnalyzingYtDlp)
  const triggerDeepYtDlpScan = useAppStore((s) => s.triggerDeepYtDlpScan)
  const refreshBookmarks = useAppStore((s) => s.refreshBookmarks)

  const [pasteUrl, setPasteUrl] = useState('')

  if (!isSidePanelOpen) return null

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const currentMedia = activeTabId ? mediaByTabId[activeTabId] || [] : []

  const handleStartHeadless = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!pasteUrl.trim()) return
    const target = pasteUrl.trim()
    setPasteUrl('')
    await window.streamgrab.headless.startProbe(target)
  }

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      {/* Side Panel Navigation Tabs */}
      <div className="flex h-11 items-center justify-between border-b border-zinc-800 px-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => openSidePanel('media')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              sidePanelTab === 'media'
                ? 'bg-zinc-800 text-emerald-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Film className="h-3.5 w-3.5" />
            Streams ({currentMedia.length})
          </button>

          <button
            type="button"
            onClick={() => openSidePanel('downloads')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              sidePanelTab === 'downloads'
                ? 'bg-zinc-800 text-cyan-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Download className="h-3.5 w-3.5" />
            Downloads ({downloads.length})
          </button>

          <button
            type="button"
            onClick={() => openSidePanel('sniff')}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
              sidePanelTab === 'sniff'
                ? 'bg-zinc-800 text-amber-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            Paste URL
          </button>

          <button
            type="button"
            onClick={() => openSidePanel('bookmarks')}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition ${
              sidePanelTab === 'bookmarks'
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Bookmark className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={closeSidePanel}
          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tab Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* 1. Detected Media Tab */}
        {sidePanelTab === 'media' && (
          <>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!activeTab || Boolean(activeTab.internalRoute) || isAnalyzingYtDlp}
                onClick={() => activeTabId && void triggerDeepYtDlpScan(activeTabId)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-300 hover:bg-purple-500/20 disabled:opacity-40"
              >
                {isAnalyzingYtDlp ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {isAnalyzingYtDlp ? 'Scanning with yt-dlp...' : 'Deep Scan Page (yt-dlp + Cookies)'}
              </button>

              {currentMedia.length > 0 && activeTabId && (
                <button
                  type="button"
                  title="Clear Detected List"
                  onClick={() => void window.streamgrab.media.clearForTab(activeTabId)}
                  className="rounded-lg border border-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {currentMedia.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center">
                <Film className="mx-auto h-8 w-8 text-zinc-600 mb-2" />
                <p className="text-xs font-medium text-zinc-300">
                  Listening for HLS, DASH, Blob & Direct Streams...
                </p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Play any video on the page. Network manifests (.m3u8 / .mpd), in-memory blob:
                  streams, and nested iframe players are captured automatically.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {currentMedia.map((m, idx) => (
                  <StreamCard key={m.id} media={m} defaultExpanded={idx === 0} />
                ))}
              </div>
            )}
          </>
        )}

        {/* 2. Downloads Tab */}
        {sidePanelTab === 'downloads' && (
          <>
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => void window.streamgrab.tabs.openInternal(null, 'downloads')}
                className="flex items-center gap-1 text-xs font-medium text-cyan-400 hover:underline"
              >
                Open Full Downloads View <ExternalLink className="h-3 w-3" />
              </button>

              {downloads.some((d) => d.status === 'completed' || d.status === 'cancelled') && (
                <button
                  type="button"
                  onClick={() => void window.streamgrab.downloads.clearCompleted()}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200"
                >
                  Clear Completed
                </button>
              )}
            </div>

            {downloads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
                No downloads yet. Grab a detected stream or click any file download link!
              </div>
            ) : (
              <div className="space-y-2.5">
                {downloads.map((task) => (
                  <DownloadItemCard key={task.id} task={task} />
                ))}
              </div>
            )}
          </>
        )}

        {/* 3. Paste-URL Headless Sniffer Tab */}
        {sidePanelTab === 'sniff' && (
          <>
            <form onSubmit={(e) => void handleStartHeadless(e)} className="space-y-2">
              <label className="block text-xs font-medium text-zinc-300">
                Headless Stream Sniffer (Hidden Muted Tab + yt-dlp)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  placeholder="https://example.com/watch/video..."
                  className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={(e) => void handleStartHeadless(e)}
                  className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
                >
                  Sniff
                </button>
              </div>
            </form>

            <div className="space-y-3 pt-1">
              {headlessJobs.map((job) => (
                <div
                  key={job.id}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium text-zinc-200" title={job.url}>
                      {job.url}
                    </p>
                    {job.status === 'probing' && (
                      <button
                        type="button"
                        onClick={() => void window.streamgrab.headless.cancelProbe(job.id)}
                        className="text-[11px] text-rose-400 hover:underline shrink-0"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    {job.status === 'probing' && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400 shrink-0" />
                    )}
                    <span>{job.stageText}</span>
                  </div>

                  {job.results.length > 0 && (
                    <div className="space-y-2 pt-1">
                      {job.results.map((m) => (
                        <StreamCard key={m.id} media={m} defaultExpanded />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* 4. Saved Bookmarks Quick Access */}
        {sidePanelTab === 'bookmarks' && (
          <div className="space-y-2">
            {bookmarks.length === 0 ? (
              <p className="py-6 text-center text-xs text-zinc-500">
                Click the star icon inside the address bar to bookmark your favorite streaming sites.
              </p>
            ) : (
              bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={() =>
                      activeTabId && void window.streamgrab.tabs.navigate(activeTabId, bm.url)
                    }
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-xs font-medium text-zinc-100">{bm.title}</p>
                    <p className="truncate text-[11px] text-zinc-500">{bm.url}</p>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await window.streamgrab.bookmarks.remove(bm.id)
                      await refreshBookmarks()
                    }}
                    className="rounded p-1 text-zinc-500 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
