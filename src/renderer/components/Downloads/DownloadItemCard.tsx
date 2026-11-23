import React from 'react'
import {
  CheckCircle2,
  FolderOpen,
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  Trash2,
  XCircle
} from 'lucide-react'
import type { DownloadTask } from '@shared/types'
import { formatBytes, formatEta, formatSpeed } from '../../utils/format'

interface DownloadItemCardProps {
  task: DownloadTask
  compact?: boolean
}

export const DownloadItemCard: React.FC<DownloadItemCardProps> = ({ task, compact = false }) => {
  const isRunning =
    task.status === 'downloading' ||
    task.status === 'muxing' ||
    task.status === 'refreshing_token' ||
    task.status === 'queued'

  const engineLabel =
    task.engine === 'hls_dash'
      ? 'HLS/DASH • N_m3u8DL-RE'
      : task.engine === 'ytdlp'
        ? 'Extractor • yt-dlp'
        : 'Multi-Range Direct'

  const statusColor =
    task.status === 'completed'
      ? 'text-emerald-400'
      : task.status === 'failed'
        ? 'text-rose-400'
        : task.status === 'refreshing_token'
          ? 'text-amber-400'
          : task.status === 'paused'
            ? 'text-zinc-400'
            : 'text-sky-400'

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-zinc-100" title={task.filename}>
            {task.filename}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
              {engineLabel}
            </span>
            {task.activeThreads && task.activeThreads > 0 ? (
              <span>• {task.activeThreads} threads</span>
            ) : null}
            {task.segmentsTotal ? (
              <span>
                • {task.segmentsDone || 0}/{task.segmentsTotal} segs
              </span>
            ) : null}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex shrink-0 items-center gap-1">
          {task.status === 'completed' && (
            <>
              <button
                type="button"
                title="Play / Open File"
                onClick={() => void window.streamgrab.downloads.openFile(task.id)}
                className="rounded-lg p-1.5 text-emerald-400 hover:bg-zinc-800"
              >
                <PlayCircle className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Show in Folder"
                onClick={() => void window.streamgrab.downloads.showInFolder(task.id)}
                className="rounded-lg p-1.5 text-zinc-300 hover:bg-zinc-800"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            </>
          )}

          {(task.status === 'downloading' || task.status === 'queued') && (
            <button
              type="button"
              title="Pause Download"
              onClick={() => void window.streamgrab.downloads.pause(task.id)}
              className="rounded-lg p-1.5 text-amber-300 hover:bg-zinc-800"
            >
              <Pause className="h-4 w-4" />
            </button>
          )}

          {(task.status === 'paused' || task.status === 'failed') && (
            <button
              type="button"
              title="Resume / Retry"
              onClick={() => void window.streamgrab.downloads.resume(task.id)}
              className="rounded-lg p-1.5 text-emerald-400 hover:bg-zinc-800"
            >
              <Play className="h-4 w-4" />
            </button>
          )}

          {isRunning && (
            <button
              type="button"
              title="Cancel"
              onClick={() => void window.streamgrab.downloads.cancel(task.id)}
              className="rounded-lg p-1.5 text-rose-400 hover:bg-zinc-800"
            >
              <XCircle className="h-4 w-4" />
            </button>
          )}

          {!isRunning && (
            <button
              type="button"
              title="Remove from List"
              onClick={() => void window.streamgrab.downloads.delete(task.id, false)}
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-all duration-200 ${
            task.status === 'completed'
              ? 'bg-emerald-500'
              : task.status === 'failed'
                ? 'bg-rose-500'
                : task.status === 'muxing'
                  ? 'bg-purple-500 animate-pulse'
                  : task.status === 'refreshing_token'
                    ? 'bg-amber-500 animate-pulse'
                    : 'bg-sky-500'
          }`}
          style={{ width: `${Math.max(2, Math.min(100, task.percent || 0))}%` }}
        />
      </div>

      {/* Status & Telemetry Row */}
      <div className="mt-2 flex items-center justify-between text-[11px]">
        <div className={`flex items-center gap-1 font-medium ${statusColor}`}>
          {task.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5" />}
          {task.status === 'refreshing_token' && (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          )}
          <span className="capitalize">
            {task.status === 'refreshing_token'
              ? `Refreshing 403 Token (#${task.tokenRefreshCount + 1})...`
              : task.status === 'muxing'
                ? 'Muxing Audio + Video (FFmpeg)...'
                : `${task.status} (${(task.percent || 0).toFixed(1)}%)`}
          </span>
        </div>

        <div className="text-zinc-400">
          {task.status === 'downloading' ? (
            <span>
              {formatSpeed(task.speedBps)} • ETA {formatEta(task.etaSec)}
            </span>
          ) : (
            <span>
              {task.downloadedBytes > 0 ? formatBytes(task.downloadedBytes) : ''}
              {task.totalBytes > 0 && task.status !== 'completed'
                ? ` / ${formatBytes(task.totalBytes)}`
                : ''}
            </span>
          )}
        </div>
      </div>

      {!compact && task.error && (
        <p className="mt-1.5 rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
          {task.error}
        </p>
      )}
    </div>
  )
}
