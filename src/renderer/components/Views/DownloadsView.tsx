import React, { useState } from 'react'
import { Download, Search, Trash2, Zap } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { DownloadItemCard } from '../Downloads/DownloadItemCard'
import { formatSpeed } from '../../utils/format'

type FilterType = 'all' | 'active' | 'completed' | 'hls_dash' | 'direct_range' | 'ytdlp'

export const DownloadsView: React.FC = () => {
  const downloads = useAppStore((s) => s.downloads)
  const openSidePanel = useAppStore((s) => s.openSidePanel)

  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')

  const activeList = downloads.filter(
    (d) =>
      d.status === 'downloading' ||
      d.status === 'muxing' ||
      d.status === 'refreshing_token' ||
      d.status === 'queued'
  )
  const totalSpeed = activeList.reduce((acc, d) => acc + (d.speedBps || 0), 0)

  const filtered = downloads.filter((d) => {
    if (search.trim() && !d.filename.toLowerCase().includes(search.trim().toLowerCase())) {
      return false
    }
    if (filter === 'active') {
      return (
        d.status === 'downloading' ||
        d.status === 'muxing' ||
        d.status === 'refreshing_token' ||
        d.status === 'queued' ||
        d.status === 'paused'
      )
    }
    if (filter === 'completed') return d.status === 'completed'
    if (filter === 'hls_dash') return d.engine === 'hls_dash'
    if (filter === 'direct_range') return d.engine === 'direct_range'
    if (filter === 'ytdlp') return d.engine === 'ytdlp'
    return true
  })

  return (
    <div className="h-full w-full overflow-y-auto bg-zinc-950 p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-zinc-100">
              <Download className="h-5 w-5 text-cyan-400" />
              Downloads Manager
            </h1>
            <p className="text-xs text-zinc-400">
              {activeList.length} active • Total Speed: {formatSpeed(totalSpeed)}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openSidePanel('sniff')}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-2 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
            >
              <Zap className="h-3.5 w-3.5" /> Paste URL to Sniff
            </button>
            <button
              type="button"
              onClick={() => void window.streamgrab.downloads.clearCompleted()}
              className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear Finished
            </button>
          </div>
        </div>

        {/* Filters & Search */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['all', 'All'],
                ['active', 'Active / Paused'],
                ['completed', 'Completed'],
                ['hls_dash', 'HLS / DASH'],
                ['direct_range', 'Direct Multi-Range'],
                ['ytdlp', 'Extractor (yt-dlp)']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  filter === key
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative w-64">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter downloads..."
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 py-1.5 text-xs text-zinc-100 focus:border-cyan-500 focus:outline-none"
            />
          </div>
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">
            No downloads match the current filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filtered.map((task) => (
              <DownloadItemCard key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
