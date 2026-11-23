import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileAudio,
  Film,
  Lock,
  Radio,
  ShieldAlert
} from 'lucide-react'
import type { DetectedMedia, TrackSelection } from '@shared/types'
import { formatBytes, formatDuration } from '../../utils/format'
import { useAppStore } from '../../store/useAppStore'

interface StreamCardProps {
  media: DetectedMedia
  defaultExpanded?: boolean
}

export const StreamCard: React.FC<StreamCardProps> = ({ media, defaultExpanded = false }) => {
  const startDownload = useAppStore((s) => s.startDownload)

  const [expanded, setExpanded] = useState(defaultExpanded)
  const [audioOnly, setAudioOnly] = useState(false)
  const [audioFormat, setAudioFormat] = useState<'m4a' | 'mp3'>('m4a')
  const [container, setContainer] = useState<'mp4' | 'mkv'>('mp4')
  const [videoTrackId, setVideoTrackId] = useState(media.videoTracks[0]?.id || 'best')
  const [selectedAudioIds, setSelectedAudioIds] = useState<string[]>(() => {
    const def = media.audioTracks.find((a) => a.isDefault) || media.audioTracks[0]
    return def ? [def.id] : []
  })
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([])
  const [customFilename, setCustomFilename] = useState(media.title)

  const selectedVideo =
    media.videoTracks.find((v) => v.id === videoTrackId) || media.videoTracks[0]

  const toggleSubId = (id: string): void => {
    setSelectedSubIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const handleDownload = (): void => {
    const selection: TrackSelection = {
      videoTrackId,
      audioTrackIds: selectedAudioIds,
      subtitleTrackIds: selectedSubIds,
      audioOnly,
      audioFormat,
      container,
      customFilename: customFilename.trim() || media.title
    }
    void startDownload(media, selection)
  }

  const typeBadgeColor =
    media.type === 'hls'
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
      : media.type === 'dash'
        ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30'
        : media.type === 'ytdlp'
          ? 'bg-purple-500/15 text-purple-400 border-purple-500/30'
          : 'bg-amber-500/15 text-amber-400 border-amber-500/30'

  return (
    <div
      className={`rounded-xl border p-3 shadow-sm transition ${
        media.isLikelyAdClip
          ? 'border-zinc-800/60 bg-zinc-900/40 opacity-65 hover:opacity-100'
          : 'border-zinc-800 bg-zinc-900/90 hover:border-zinc-700'
      }`}
    >
      <div className="flex gap-3">
        {media.thumbnail ? (
          <img
            src={media.thumbnail}
            alt=""
            className="h-16 w-24 shrink-0 rounded-lg bg-zinc-800 object-cover"
          />
        ) : (
          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-500">
            <Film className="h-6 w-6" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${typeBadgeColor}`}
            >
              {media.type === 'ytdlp' ? 'EXTRACTOR' : media.type.toUpperCase()}
            </span>

            {media.isEncryptedAes128 && (
              <span className="flex items-center gap-0.5 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300">
                <Lock className="h-2.5 w-2.5" /> AES-128
              </span>
            )}

            {media.isLive && (
              <span className="flex items-center gap-0.5 rounded border border-rose-500/30 bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-400">
                <Radio className="h-2.5 w-2.5" /> LIVE
              </span>
            )}

            {media.isLikelyAdClip && (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                Short Ad / Clip
              </span>
            )}

            {media.isDrmProtected && (
              <span className="flex items-center gap-0.5 rounded border border-red-500/40 bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                <ShieldAlert className="h-3 w-3" /> DRM ({media.drmSystem || 'Protected'})
              </span>
            )}
          </div>

          <p className="truncate text-xs font-medium text-zinc-100" title={media.title}>
            {media.title}
          </p>

          <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400">
            {media.durationSec && <span>{formatDuration(media.durationSec)}</span>}
            {(selectedVideo?.estimatedBytes || media.sizeBytes) && (
              <span>• {formatBytes(selectedVideo?.estimatedBytes || media.sizeBytes)}</span>
            )}
            <span>• {media.videoTracks.length} quality option(s)</span>
          </div>
        </div>
      </div>

      {/* Quick Actions Row */}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/70 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
        >
          <span className="truncate">
            {audioOnly
              ? `Audio Only (.${audioFormat.toUpperCase()})`
              : selectedVideo?.label || 'Select Tracks'}
          </span>
          {expanded ? <ChevronUp className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        </button>

        <button
          type="button"
          disabled={media.isDrmProtected}
          onClick={handleDownload}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          <Download className="h-3.5 w-3.5" />
          Grab
        </button>
      </div>

      {/* Expanded Track & Container Picker */}
      {expanded && (
        <div className="mt-3 space-y-2.5 border-t border-zinc-800/80 pt-3 text-xs">
          {/* Mode Toggle: Video+Audio vs Audio-Only */}
          {media.type !== 'direct' && (
            <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-zinc-950 p-1 border border-zinc-800">
              <button
                type="button"
                onClick={() => setAudioOnly(false)}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1 font-medium transition ${
                  !audioOnly ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Film className="h-3.5 w-3.5" /> Video + Audio
              </button>
              <button
                type="button"
                onClick={() => setAudioOnly(true)}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1 font-medium transition ${
                  audioOnly ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <FileAudio className="h-3.5 w-3.5" /> Audio Only
              </button>
            </div>
          )}

          {/* Filename */}
          <div>
            <label className="mb-1 block text-[11px] text-zinc-400">Save Filename</label>
            <input
              type="text"
              value={customFilename}
              onChange={(e) => setCustomFilename(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>

          {/* Video Quality Selector */}
          {!audioOnly && media.videoTracks.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">Resolution / Video Stream</label>
              <select
                value={videoTrackId}
                onChange={(e) => setVideoTrackId(e.target.value)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                {media.videoTracks.map((vt) => (
                  <option key={vt.id} value={vt.id}>
                    {vt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Audio Track Selector */}
          {media.audioTracks.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">Audio Language / Track</label>
              <select
                value={selectedAudioIds[0] || ''}
                onChange={(e) => setSelectedAudioIds(e.target.value ? [e.target.value] : [])}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                {media.audioTracks.map((at) => (
                  <option key={at.id} value={at.id}>
                    {at.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Subtitle Selector */}
          {!audioOnly && media.subtitleTracks.length > 0 && (
            <div>
              <label className="mb-1 block text-[11px] text-zinc-400">
                Embed Subtitles ({selectedSubIds.length} selected)
              </label>
              <div className="max-h-24 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-1.5 space-y-1">
                {media.subtitleTracks.map((st) => (
                  <label
                    key={st.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 hover:bg-zinc-900"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSubIds.includes(st.id)}
                      onChange={() => toggleSubId(st.id)}
                      className="accent-emerald-500"
                    />
                    <span className="truncate text-zinc-300">{st.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Container / Audio Format */}
          {media.type !== 'direct' && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-[11px] text-zinc-400">Output Format</span>
              {audioOnly ? (
                <div className="flex gap-1.5">
                  {(['m4a', 'mp3'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setAudioFormat(fmt)}
                      className={`rounded border px-2.5 py-1 text-[11px] font-medium uppercase ${
                        audioFormat === fmt
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400'
                      }`}
                    >
                      .{fmt}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex gap-1.5">
                  {(['mp4', 'mkv'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setContainer(fmt)}
                      className={`rounded border px-2.5 py-1 text-[11px] font-medium uppercase ${
                        container === fmt
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-400'
                      }`}
                    >
                      .{fmt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
