export type InternalRoute = 'newtab' | 'downloads' | 'bookmarks' | 'history' | 'settings' | null

export type SidePanelTab = 'media' | 'downloads' | 'sniff' | 'bookmarks'

export interface TabState {
  id: string
  url: string
  title: string
  favicon?: string
  isIncognito: boolean
  isMuted: boolean
  isAudible: boolean
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  blockedAdsCount: number
  detectedMediaCount: number
  isSiteWhitelisted: boolean
  internalRoute: InternalRoute
}

export interface VideoTrackOption {
  id: string
  label: string
  width?: number
  height?: number
  fps?: number
  bandwidth?: number
  codecs?: string
  estimatedBytes?: number
  selector?: string
}

export interface AudioTrackOption {
  id: string
  label: string
  language?: string
  name?: string
  codecs?: string
  bandwidth?: number
  isDefault?: boolean
  selector?: string
}

export interface SubtitleTrackOption {
  id: string
  label: string
  language?: string
  name?: string
  uri?: string
  selector?: string
}

export type MediaType = 'hls' | 'dash' | 'direct' | 'ytdlp'

export interface DetectedMedia {
  id: string
  tabId: string
  type: MediaType
  url: string
  sourcePageUrl: string
  frameUrl: string
  title: string
  thumbnail?: string
  durationSec?: number
  sizeBytes?: number
  mimeType?: string
  containerHint?: string
  isLive?: boolean
  isEncryptedAes128?: boolean
  isLikelyAdClip?: boolean
  isDrmProtected: boolean
  drmSystem?: string
  videoTracks: VideoTrackOption[]
  audioTracks: AudioTrackOption[]
  subtitleTracks: SubtitleTrackOption[]
  requestHeaders: Record<string, string>
  partition: string
  localManifestPath?: string
  rawManifestText?: string
  baseUrl?: string
  mediaSignature: string
  capturedAt: number
}

export interface TrackSelection {
  videoTrackId?: string
  videoSelector?: string
  audioTrackIds?: string[]
  audioSelector?: string
  subtitleTrackIds?: string[]
  subtitleSelector?: string
  audioOnly: boolean
  audioFormat: 'm4a' | 'mp3'
  container: 'mp4' | 'mkv'
  customFilename?: string
}

export type DownloadEngineType = 'hls_dash' | 'direct_range' | 'ytdlp'

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'muxing'
  | 'paused'
  | 'refreshing_token'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DownloadTask {
  id: string
  mediaId?: string
  engine: DownloadEngineType
  status: DownloadStatus
  title: string
  filename: string
  savePath: string
  url: string
  sourcePageUrl: string
  partition: string
  requestHeaders: Record<string, string>
  localManifestPath?: string
  baseUrl?: string
  trackSelection: TrackSelection
  mediaSignature: string
  totalBytes: number
  downloadedBytes: number
  speedBps: number
  etaSec: number
  percent: number
  segmentsDone?: number
  segmentsTotal?: number
  activeThreads?: number
  tokenRefreshCount: number
  error?: string
  createdAt: number
  completedAt?: number
}

export interface DownloadChunkRecord {
  taskId: string
  chunkIndex: number
  startByte: number
  currentByte: number
  endByte: number
  status: 'pending' | 'active' | 'completed'
}

export interface HeadlessProbeJob {
  id: string
  url: string
  status: 'probing' | 'completed' | 'failed'
  stageText: string
  results: DetectedMedia[]
  error?: string
  startedAt: number
}

export interface BookmarkItem {
  id: string
  url: string
  title: string
  favicon?: string
  folder: string
  createdAt: number
}

export interface HistoryItem {
  id: string
  url: string
  title: string
  favicon?: string
  visitedAt: number
  visitCount: number
}

export interface AppSettings {
  downloadDir: string
  maxThreadsPerDownload: number
  maxConcurrentDownloads: number
  adblockEnabled: boolean
  whitelistedDomains: string[]
  interceptStandardDownloads: boolean
  minDirectMediaBytes: number
  autoRefreshExpiredTokens: boolean
  searchEngine: 'duckduckgo' | 'google' | 'bing'
}

export interface BinaryStatus {
  name: 'ffmpeg' | 'ffprobe' | 'N_m3u8DL-RE' | 'yt-dlp'
  installed: boolean
  path: string | null
  version: string | null
  isPortableLocal: boolean
}

export interface BinaryHealthReport {
  portableRoot: string
  dataRoot: string
  binariesDir: string
  binaries: BinaryStatus[]
}
