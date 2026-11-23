import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { DetectedMedia, TabState } from '@shared/types'
import type { DatabaseService } from '../storage/DatabaseService'
import type { SessionManager } from '../browser/SessionManager'
import { diagLogger, type LogCategory } from '../logger/DiagnosticLogger'
import { resolvePortablePaths } from '../portable/PortablePaths'
import { CookieExporter } from './CookieExporter'
import { detectAndParseManifest, type ParsedManifestResult } from './ManifestParser'
import { isKnownExtractorSite, YtDlpInspector } from './YtDlpInspector'

interface PendingRequestInfo {
  url: string
  method: string
  resourceType: string
  headers: Record<string, string>
  frameUrl?: string
  sessionId?: string
  mimeType?: string
  statusCode?: number
  contentLength?: number
  acceptRanges?: string
  isCandidateManifest: boolean
  isCandidateDirectMedia: boolean
}

interface AttachedTabContext {
  tabId: string
  webContents: WebContents
  partition: string
  getTabState: () => TabState | undefined
  requests: Map<string, PendingRequestInfo>
  wireHeadersByHost: Map<string, Record<string, string>>
  masterMediaIdByVariantUrl: Map<string, string>
  blobUrlToLocalManifest: Map<string, string>
  lastDurationSec?: number
  lastVideoHeight?: number
  lastVideoWidth?: number
  lastPoster?: string
  lastPageTitle?: string
  autoAnalyzedUrls: Set<string>
}

const MANIFEST_MIME_REGEX =
  /mpegurl|dash\+xml|vnd\.ms-sstr\+xml|f4m\+xml|apple\.mpegurl/i

const MANIFEST_URL_REGEX =
  /\.(m3u8|mpd|ism\/manifest)(\?|#|$)|\/(manifest|master|playlist|hls|dash|getvideo)([/?#.]|$)/i

// Only filter explicit binary segment paths & fonts/stylesheets — NEVER drop .txt/.png/.jpg/.html XHRs before checking body size & magic bytes!
const HARD_SKIP_STATIC_REGEX =
  /\.(woff2?|ttf|otf|eot|css|ico|svg)(\?|#|$)|videoplayback\?|\/seg[-_]?\d+\.(ts|m4s)|chunk[-_]?\d+\.(ts|m4s)|fragment[-_]?\d+\.(ts|m4s)/i

const DIRECT_MEDIA_EXT_REGEX = /\.(mp4|mkv|webm|mov|flv|avi|mp3|m4a|flac|wav|ogg)(\?|#|$)/i
const DIRECT_MEDIA_MIME_REGEX =
  /^(video|audio)\/(mp4|webm|x-matroska|quicktime|x-flv|mpeg|mp4a|flac|ogg|wav)/i

const MAX_MANIFEST_BYTES = 3 * 1024 * 1024 // 3 MB upper ceiling for text manifests

export function computeMediaSignature(
  type: string,
  rawUrl: string,
  extraFingerprint?: string
): string {
  try {
    const clean = rawUrl.startsWith('blob:') ? rawUrl.slice(5) : rawUrl
    const u = new URL(clean)
    const stablePath = u.pathname
      .replace(/\/[0-9a-f]{16,}\//gi, '/<token>/')
      .replace(/\/\d{9,13}\//g, '/<ts>/')
    return extraFingerprint
      ? `${type}:${u.hostname}${stablePath}#${extraFingerprint}`
      : `${type}:${u.hostname}${stablePath}`
  } catch {
    return `${type}:${rawUrl.slice(0, 100)}#${extraFingerprint || ''}`
  }
}

function computeManifestStructureFingerprint(parsed: ParsedManifestResult): string {
  const lines = parsed.normalizedManifestText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  // Hash stable structural properties (track count, top height, segment count bucket, first URL stem)
  // so a 23s 720p pre-roll ad and a 32m 1080p episode NEVER collide, even when both use blob: URLs!
  const firstStem = lines[0] ? lines[0].split('?')[0].slice(-48) : ''
  const topHeight = parsed.videoTracks[0]?.height || 0
  const segBucket = Math.floor(parsed.segmentCount / 5)
  const rawKey = `${parsed.isMaster ? 'M' : 'V'}|${parsed.videoTracks.length}|${topHeight}|${segBucket}|${firstStem}`
  return crypto.createHash('sha1').update(rawKey).digest('hex').slice(0, 10)
}

function safeOrigin(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined
  try {
    const clean = rawUrl.startsWith('blob:') ? rawUrl.slice(5) : rawUrl
    const origin = new URL(clean).origin
    return origin && origin !== 'null' ? origin : undefined
  } catch {
    return undefined
  }
}

export class SnifferManager {
  private db: DatabaseService
  private sessionManager: SessionManager
  private ytdlpInspector: YtDlpInspector

  private contextsByTabId = new Map<string, AttachedTabContext>()
  private tabIdByWcId = new Map<number, string>()
  private mediaByTabId = new Map<string, DetectedMedia[]>()

  private onTabMediaChanged?: (tabId: string, list: DetectedMedia[]) => void
  private mediaListeners = new Set<(media: DetectedMedia) => void>()

  constructor(
    db: DatabaseService,
    sessionManager: SessionManager,
    ytdlpInspector: YtDlpInspector,
    onTabMediaChanged?: (tabId: string, list: DetectedMedia[]) => void
  ) {
    this.db = db
    this.sessionManager = sessionManager
    this.ytdlpInspector = ytdlpInspector
    this.onTabMediaChanged = onTabMediaChanged

    this.registerInternalPreloadIpc()
  }

  public onMediaCaptured(listener: (media: DetectedMedia) => void): () => void {
    this.mediaListeners.add(listener)
    return () => this.mediaListeners.delete(listener)
  }

  public getMediaForTab(tabId: string): DetectedMedia[] {
    const raw = this.mediaByTabId.get(tabId) || []
    return this.sortAndFlagStreams(raw)
  }

  public clearMediaForTab(tabId: string): void {
    const ctx = this.contextsByTabId.get(tabId)
    if (ctx) {
      ctx.masterMediaIdByVariantUrl.clear()
      ctx.blobUrlToLocalManifest.clear()
      ctx.wireHeadersByHost.clear()
      ctx.lastDurationSec = undefined
    }
    this.mediaByTabId.set(tabId, [])
    this.onTabMediaChanged?.(tabId, [])
  }

  public handleTabNavigation(tabId: string, newUrl: string): void {
    this.clearMediaForTab(tabId)
    const ctx = this.contextsByTabId.get(tabId)
    if (ctx && isKnownExtractorSite(newUrl) && !ctx.autoAnalyzedUrls.has(newUrl)) {
      ctx.autoAnalyzedUrls.add(newUrl)
      void this.deepAnalyzeWithYtDlp(tabId, newUrl)
    }
  }

  public async deepAnalyzeWithYtDlp(
    tabId: string,
    overrideUrl?: string
  ): Promise<DetectedMedia | null> {
    const ctx = this.contextsByTabId.get(tabId)
    const targetUrl = overrideUrl || ctx?.getTabState()?.url || ctx?.webContents.getURL()
    if (!targetUrl || !targetUrl.startsWith('http')) return null

    const partition = ctx?.partition || 'persist:browser'
    const sess = this.sessionManager.getSessionByPartition(partition)
    const result = await this.ytdlpInspector.inspectUrl({
      url: targetUrl,
      tabId,
      partition,
      session: sess
    })
    if (result) {
      this.recordDetectedMedia(tabId, result)
    }
    return result
  }

  public attachToTab(
    tabId: string,
    webContents: WebContents,
    partition: string,
    getTabState: () => TabState | undefined
  ): void {
    const ctx: AttachedTabContext = {
      tabId,
      webContents,
      partition,
      getTabState,
      requests: new Map(),
      wireHeadersByHost: new Map(),
      masterMediaIdByVariantUrl: new Map(),
      blobUrlToLocalManifest: new Map(),
      autoAnalyzedUrls: new Set()
    }

    this.contextsByTabId.set(tabId, ctx)
    this.tabIdByWcId.set(webContents.id, tabId)
    if (!this.mediaByTabId.has(tabId)) {
      this.mediaByTabId.set(tabId, [])
    }

    webContents.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
      if (!isMainFrame) return
      if (isKnownExtractorSite(url) && !ctx.autoAnalyzedUrls.has(url)) {
        ctx.autoAnalyzedUrls.add(url)
        void this.deepAnalyzeWithYtDlp(tabId, url)
      }
    })

    try {
      if (!webContents.debugger.isAttached()) {
        webContents.debugger.attach('1.3')
      }
    } catch (err) {
      console.warn(`[SnifferManager] Could not attach CDP debugger to tab ${tabId}:`, err)
      return
    }

    webContents.debugger.on('message', (_event, method, params, sessionId) => {
      void this.handleCdpEvent(ctx, method, params, sessionId || undefined)
    })

    void (async () => {
      try {
        await webContents.debugger.sendCommand('Network.enable', {
          maxPostDataSize: 65536
        })
        await webContents.debugger.sendCommand('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true
        })
      } catch (err) {
        console.warn('[SnifferManager] CDP initialization error:', err)
      }
    })()
  }

  public detachFromTab(tabId: string): void {
    const ctx = this.contextsByTabId.get(tabId)
    if (ctx) {
      this.tabIdByWcId.delete(ctx.webContents.id)
      if (!ctx.webContents.isDestroyed() && ctx.webContents.debugger.isAttached()) {
        try {
          ctx.webContents.debugger.detach()
        } catch {
          // ignore
        }
      }
      this.contextsByTabId.delete(tabId)
    }
    this.mediaByTabId.delete(tabId)
  }

  private async handleCdpEvent(
    ctx: AttachedTabContext,
    method: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: Record<string, any>,
    sessionId?: string
  ): Promise<void> {
    if (ctx.webContents.isDestroyed()) return

    // Auto-attach Network inspector to ALL subtargets: Out-of-Process iframes AND Dedicated Web Workers (hls.js worker!)
    if (method === 'Target.attachedToTarget') {
      const childSessionId = params.sessionId as string | undefined
      diagLogger.log(
        'CDP_TARGET',
        'attachedToTarget',
        {
          targetType: params.targetInfo?.type,
          targetUrl: params.targetInfo?.url,
          sessionId: childSessionId
        },
        { tabId: ctx.tabId, url: params.targetInfo?.url }
      )
      if (childSessionId) {
        try {
          await ctx.webContents.debugger.sendCommand('Network.enable', {}, childSessionId)
          await ctx.webContents.debugger
            .sendCommand(
              'Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
              childSessionId
            )
            .catch(() => {})
          if (params.waitingForDebugger) {
            await ctx.webContents.debugger.sendCommand(
              'Runtime.runIfWaitingForDebugger',
              {},
              childSessionId
            )
          }
        } catch {
          // Subtarget closed during attach
        }
      }
      return
    }

    const reqKey = `${sessionId || 'main'}:${params.requestId || ''}`

    if (method === 'Network.requestWillBeSent') {
      const url = String(params.request?.url || '')
      if (!url.startsWith('http://') && !url.startsWith('https://')) return
      if (HARD_SKIP_STATIC_REGEX.test(url)) return

      const headers = this.normalizeHeaderMap(params.request?.headers || {})
      try {
        ctx.wireHeadersByHost.set(new URL(url).hostname.toLowerCase(), headers)
      } catch {
        // ignore invalid url
      }
      ctx.requests.set(reqKey, {
        url,
        method: String(params.request?.method || 'GET'),
        resourceType: String(params.type || 'Other'),
        headers,
        frameUrl: String(params.documentURL || headers.referer || ''),
        sessionId,
        isCandidateManifest: false,
        isCandidateDirectMedia: false
      })

      if (ctx.requests.size > 2000) {
        const oldestKey = ctx.requests.keys().next().value
        if (oldestKey) ctx.requests.delete(oldestKey)
      }
      return
    }

    if (method === 'Network.requestWillBeSentExtraInfo') {
      const existing = ctx.requests.get(reqKey)
      if (existing && params.headers) {
        existing.headers = {
          ...existing.headers,
          ...this.normalizeHeaderMap(params.headers)
        }
        try {
          ctx.wireHeadersByHost.set(
            new URL(existing.url).hostname.toLowerCase(),
            existing.headers
          )
        } catch {
          // ignore
        }
      }
      return
    }

    if (method === 'Network.responseReceived') {
      const resp = params.response || {}
      const url = String(resp.url || '')
      const statusCode = Number(resp.status || 0)
      if (statusCode >= 400 || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        ctx.requests.delete(reqKey)
        return
      }
      if (HARD_SKIP_STATIC_REGEX.test(url)) {
        ctx.requests.delete(reqKey)
        return
      }

      const respHeaders = this.normalizeHeaderMap(resp.headers || {})
      const mimeType = String(resp.mimeType || respHeaders['content-type'] || '').toLowerCase()
      const contentRange = respHeaders['content-range'] || ''
      const contentLength = this.parseTotalContentLength(respHeaders['content-length'], contentRange)

      let info = ctx.requests.get(reqKey)
      if (!info) {
        info = {
          url,
          method: 'GET',
          resourceType: String(params.type || 'Other'),
          headers: {},
          sessionId,
          isCandidateManifest: false,
          isCandidateDirectMedia: false
        }
        ctx.requests.set(reqKey, info)
      }

      info.url = url
      info.mimeType = mimeType
      info.statusCode = statusCode
      info.contentLength = contentLength
      info.acceptRanges = respHeaders['accept-ranges']

      const isExplicitManifest = MANIFEST_MIME_REGEX.test(mimeType) || MANIFEST_URL_REGEX.test(url)
      const isXhrOrFetchCandidate =
        (info.resourceType === 'XHR' ||
          info.resourceType === 'Fetch' ||
          info.resourceType === 'Media' ||
          info.resourceType === 'Other') &&
        !mimeType.startsWith('video/mp2t') &&
        (contentLength === 0 || contentLength <= MAX_MANIFEST_BYTES)

      if (isExplicitManifest || isXhrOrFetchCandidate) {
        info.isCandidateManifest = true
        diagLogger.log(
          'CDP_NETWORK',
          'candidate_response',
          {
            method: info.method,
            resourceType: info.resourceType,
            status: statusCode,
            mimeType,
            contentLength,
            sessionId: sessionId || 'main',
            frameUrl: info.frameUrl
          },
          { tabId: ctx.tabId, url }
        )
      }

      // Direct progressive MP4/MKV/WebM/MP3 capture (only when clearly a real progressive media file, not a tiny segment)
      const isDirectMedia =
        (DIRECT_MEDIA_MIME_REGEX.test(mimeType) || DIRECT_MEDIA_EXT_REGEX.test(url)) &&
        !isExplicitManifest &&
        !/\.(ts|m4s)(\?|#|$)/i.test(url)

      const minBytes = this.db.getSettings().minDirectMediaBytes
      if (isDirectMedia && contentLength >= minBytes) {
        info.isCandidateDirectMedia = true
        await this.captureDirectMediaFromResponse(ctx, info)
      }
      return
    }

    if (method === 'Network.loadingFinished') {
      const info = ctx.requests.get(reqKey)
      if (!info) return
      ctx.requests.delete(reqKey)

      const encodedLen = Number(params.encodedDataLength || 0)
      if (
        info.isCandidateManifest &&
        (encodedLen === 0 || (encodedLen >= 12 && encodedLen <= MAX_MANIFEST_BYTES))
      ) {
        await this.captureManifestFromRamCache(ctx, String(params.requestId), info)
      }
    }
  }

  private async captureManifestFromRamCache(
    ctx: AttachedTabContext,
    requestId: string,
    info: PendingRequestInfo
  ): Promise<void> {
    if (ctx.webContents.isDestroyed()) return

    try {
      const bodyResp = (await ctx.webContents.debugger.sendCommand(
        'Network.getResponseBody',
        { requestId },
        info.sessionId
      )) as { body?: string; base64Encoded?: boolean }

      if (!bodyResp?.body) return

      // Fast reject for binary responses encoded as base64 unless they start with #EXTM3U / <?xml / <MPD / JSON
      let rawText: string
      if (bodyResp.base64Encoded) {
        const buf = Buffer.from(bodyResp.body, 'base64')
        if (buf.byteLength < 7 || buf.byteLength > MAX_MANIFEST_BYTES) return
        const head = buf.subarray(0, Math.min(512, buf.byteLength)).toString('utf8').trimStart()
        if (
          !head.startsWith('#EXTM3U') &&
          !head.includes('<MPD') &&
          !head.startsWith('<?xml') &&
          !head.startsWith('{')
        ) {
          return
        }
        rawText = buf.toString('utf8')
      } else {
        rawText = bodyResp.body
      }

      const trimmedHead = rawText.slice(0, 1024).trimStart()

      // Case 1: Standard or Disguised (#EXTM3U / <MPD) manifest (catches .txt, .png, .html, chunked POST/GET!)
      if (
        trimmedHead.startsWith('#EXTM3U') ||
        trimmedHead.includes('<MPD') ||
        (trimmedHead.startsWith('<?xml') && rawText.slice(0, 4096).includes('<MPD'))
      ) {
        const dumpPath = diagLogger.dumpRawArtifact('cdp_manifest', 'txt', rawText)
        diagLogger.log(
          'CDP_BODY',
          'manifest_body_captured',
          {
            mimeType: info.mimeType,
            resourceType: info.resourceType,
            length: rawText.length,
            dumpPath,
            head: trimmedHead.slice(0, 300)
          },
          { tabId: ctx.tabId, url: info.url }
        )
        await this.ingestManifestPayload(ctx, {
          rawText,
          manifestUrl: info.url,
          frameUrl: info.frameUrl || ctx.webContents.getURL(),
          requestHeaders: info.headers,
          hasExactWireHeaders: true
        })
        return
      }

      // Case 2: FirePlayer / PlayerJS / JWPlayer JSON config response (e.g., POST ?do=getVideo -> {"hls":true,"videoSource":"https://..."})
      if (trimmedHead.startsWith('{') && rawText.length < 128 * 1024) {
        if (/videoSource|securedLink|m3u8|mpd|hls|sources|playlist|stream/i.test(rawText)) {
          const dumpPath = diagLogger.dumpRawArtifact('player_json', 'json', rawText)
          diagLogger.log(
            'CDP_BODY',
            'interesting_json_response',
            { dumpPath, snippet: rawText.slice(0, 500) },
            { tabId: ctx.tabId, url: info.url }
          )
        }
        await this.tryExtractStreamFromPlayerJson(ctx, rawText, info)
      }
    } catch {
      // Body evicted if frame closed
    }
  }

  private async tryExtractStreamFromPlayerJson(
    ctx: AttachedTabContext,
    jsonText: string,
    info: PendingRequestInfo
  ): Promise<void> {
    try {
      const data = JSON.parse(jsonText) as Record<string, unknown>
      const candidateUrls: string[] = []
      for (const key of ['videoSource', 'securedLink', 'hls', 'file', 'manifest']) {
        const val = data[key]
        if (typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://'))) {
          candidateUrls.push(val)
        }
      }
      if (Array.isArray(data.videoSources)) {
        for (const item of data.videoSources) {
          const f = (item as Record<string, unknown>)?.file
          if (typeof f === 'string' && (f.startsWith('http://') || f.startsWith('https://'))) {
            candidateUrls.push(f)
          }
        }
      }
      if (candidateUrls.length === 0) return

      // Pre-fetch candidate manifest inside the tab's own session cookies/headers if player hasn't loaded it yet
      const sess = this.sessionManager.getSessionByPartition(ctx.partition)
      const frameRef = info.frameUrl || ctx.webContents.getURL()
      for (const streamUrl of candidateUrls) {
        const cookie = await CookieExporter.getCookieHeaderForUrl(sess, streamUrl)
        const headers: Record<string, string> = {
          'User-Agent': info.headers['user-agent'] || sess.getUserAgent(),
          Referer: frameRef
        }
        const orig = safeOrigin(frameRef)
        if (orig) headers.Origin = orig
        if (cookie) headers.Cookie = cookie

        const res = await sess.fetch(streamUrl, { headers }).catch(() => null)
        if (res && res.ok) {
          const text = await res.text().catch(() => '')
          if (text.trimStart().startsWith('#EXTM3U') || text.includes('<MPD')) {
            await this.ingestManifestPayload(ctx, {
              rawText: text,
              manifestUrl: streamUrl,
              frameUrl: frameRef,
              requestHeaders: this.normalizeHeaderMap(headers)
            })
          }
        }
      }
    } catch {
      // Not player JSON
    }
  }

  private async ingestManifestPayload(
    ctx: AttachedTabContext,
    payload: {
      rawText: string
      manifestUrl: string
      frameUrl: string
      requestHeaders: Record<string, string>
      hasExactWireHeaders?: boolean
      pageTitleHint?: string
    }
  ): Promise<void> {
    const baseForResolution = payload.manifestUrl.startsWith('blob:')
      ? payload.frameUrl
      : payload.manifestUrl

    const parsed = detectAndParseManifest(payload.rawText, baseForResolution)
    if (!parsed) return

    // Rewrite any child blob:https://... references inside a Master blob playlist to locally saved .m3u8 paths!
    let finalManifestText = parsed.normalizedManifestText
    if (ctx.blobUrlToLocalManifest.size > 0 && finalManifestText.includes('blob:')) {
      for (const [childBlobUrl, childLocalPath] of ctx.blobUrlToLocalManifest.entries()) {
        if (finalManifestText.includes(childBlobUrl)) {
          finalManifestText = finalManifestText.split(childBlobUrl).join(childLocalPath)
        }
      }
    }

    // Check if this URL is a child variant playlist of an already-captured Master playlist!
    const parentMasterId = ctx.masterMediaIdByVariantUrl.get(payload.manifestUrl)
    if (parentMasterId && !parsed.isMaster) {
      // Enrich the parent Master playlist with exact #EXTINF duration (e.g., 32:11 = 1931s!) & AES-128 status!
      this.enrichMasterFromChildVariant(ctx.tabId, parentMasterId, parsed)
      return
    }

    const paths = resolvePortablePaths()
    const id = crypto.randomUUID()
    const ext = parsed.type === 'hls' ? 'm3u8' : 'mpd'
    const localManifestPath = path.join(paths.manifestsCacheDir, `${id}.${ext}`)
    await fs.promises.writeFile(localManifestPath, finalManifestText, 'utf8')

    if (payload.manifestUrl.startsWith('blob:')) {
      ctx.blobUrlToLocalManifest.set(payload.manifestUrl, localManifestPath)
    }

    if (parsed.type === 'hls' && parsed.isMaster) {
      for (const line of finalManifestText.split(/\r?\n/)) {
        const t = line.trim()
        if (t.startsWith('http://') || t.startsWith('https://')) {
          ctx.masterMediaIdByVariantUrl.set(t, id)
        } else if (t.startsWith('#')) {
          // Also register #EXT-X-MEDIA URI="https://..." (separate audio & subtitle sub-playlists!)
          // so stream_a0/index.m3u8 doesn't leak into the UI as a fake standalone video card!
          const uriRegex = /URI="([^"]+)"/gi
          let match: RegExpExecArray | null
          while ((match = uriRegex.exec(t)) !== null) {
            const subUri = match[1].trim()
            if (subUri.startsWith('http://') || subUri.startsWith('https://')) {
              ctx.masterMediaIdByVariantUrl.set(subUri, id)
            }
          }
        }
      }
    }

    const sess = this.sessionManager.getSessionByPartition(ctx.partition)
    const sourcePageUrl = ctx.getTabState()?.url || ctx.webContents.getURL() || payload.frameUrl

    // Crucial for iframe players (VidMoly, FirePlayer, DiziPal Orjinal):
    // Use the iframe's own URL as Referer/Origin when request came from inside an embed iframe!
    const effectiveFrameUrl =
      payload.frameUrl && payload.frameUrl.startsWith('http') ? payload.frameUrl : sourcePageUrl

    const cookiesList = await Promise.all([
      CookieExporter.getCookieHeaderForUrl(
        sess,
        payload.manifestUrl.startsWith('blob:') ? effectiveFrameUrl : payload.manifestUrl
      ),
      CookieExporter.getCookieHeaderForUrl(sess, effectiveFrameUrl)
    ])
    const mergedCookie = Array.from(
      new Set(
        cookiesList
          .flatMap((c) => c.split('; '))
          .map((s) => s.trim())
          .filter(Boolean)
      )
    ).join('; ')

    // Resolve exact outgoing headers:
    // CRITICAL: Many embed players (e.g. FirePlayer wrapping video.twimg.com) set
    // <meta name="referrer" content="no-referrer">. Sending a fabricated Referer/Origin
    // triggers 403 anti-hotlinking! Always mirror what Chromium ACTUALLY sent on the wire!
    let wireHeaders = payload.requestHeaders
    let hasTrueWireSample = Boolean(payload.hasExactWireHeaders)

    if (!hasTrueWireSample && !payload.manifestUrl.startsWith('blob:')) {
      try {
        const hostSample = ctx.wireHeadersByHost.get(new URL(payload.manifestUrl).hostname.toLowerCase())
        if (hostSample) {
          wireHeaders = hostSample
          hasTrueWireSample = true
        }
      } catch {
        // ignore
      }
    }

    const cleanHeaders: Record<string, string> = {
      'User-Agent': wireHeaders['user-agent'] || sess.getUserAgent()
    }

    if (hasTrueWireSample) {
      // Exact 1:1 mirror of Chromium's wire headers: only include Referer/Origin if Chromium sent them!
      if (wireHeaders.referer) cleanHeaders.Referer = wireHeaders.referer
      if (wireHeaders.origin) cleanHeaders.Origin = wireHeaders.origin
      if (wireHeaders.authorization) cleanHeaders.Authorization = wireHeaders.authorization
    } else {
      // Pure in-memory blob: manifest where wire headers weren't observed yet:
      // Check first segment/variant host in wireHeadersByHost before falling back to effectiveFrameUrl
      const firstExternalHost = finalManifestText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.startsWith('http://') || l.startsWith('https://'))

      let segHostHeaders: Record<string, string> | undefined
      if (firstExternalHost) {
        try {
          segHostHeaders = ctx.wireHeadersByHost.get(
            new URL(firstExternalHost).hostname.toLowerCase()
          )
        } catch {
          // ignore
        }
      }

      if (segHostHeaders) {
        if (segHostHeaders.referer) cleanHeaders.Referer = segHostHeaders.referer
        if (segHostHeaders.origin) cleanHeaders.Origin = segHostHeaders.origin
      } else {
        cleanHeaders.Referer = effectiveFrameUrl
        const inferredOrigin = safeOrigin(effectiveFrameUrl)
        if (inferredOrigin) cleanHeaders.Origin = inferredOrigin
      }
    }

    if (mergedCookie) {
      cleanHeaders.Cookie = mergedCookie
    } else if (wireHeaders.cookie) {
      cleanHeaders.Cookie = wireHeaders.cookie
    }

    const baseDirUrl = baseForResolution.replace(/\/[^/?#]*([?#].*)?$/, '/')
    const tabTitle =
      ctx.getTabState()?.title || payload.pageTitleHint || ctx.lastPageTitle || 'Detected Stream'

    // If this is a single-variant media playlist (e.g. 1080p media playlist with #EXTINF) where resolution wasn't in a Master tag,
    // label it with the live <video> element's resolution if known!
    if (
      !parsed.isMaster &&
      parsed.videoTracks.length === 1 &&
      !parsed.videoTracks[0].height &&
      ctx.lastVideoHeight &&
      (!parsed.durationSec || !ctx.lastDurationSec || Math.abs(parsed.durationSec - ctx.lastDurationSec) < 15)
    ) {
      parsed.videoTracks[0].height = ctx.lastVideoHeight
      parsed.videoTracks[0].width = ctx.lastVideoWidth
      parsed.videoTracks[0].label = `${ctx.lastVideoHeight}p${
        ctx.lastVideoWidth ? ` (${ctx.lastVideoWidth}x${ctx.lastVideoHeight})` : ''
      } • Active Stream`
    }

    // Only use ctx.lastDurationSec on Master playlists (which lack #EXTINF), and ONLY if lastDurationSec > 45s (avoid stamping 0:23 ad duration onto the main episode!)
    const durationSec =
      parsed.durationSec ||
      (parsed.isMaster && ctx.lastDurationSec && ctx.lastDurationSec > 45
        ? ctx.lastDurationSec
        : undefined)

    if (durationSec) {
      for (const vt of parsed.videoTracks) {
        if (vt.bandwidth && !vt.estimatedBytes) {
          vt.estimatedBytes = Math.round((vt.bandwidth * durationSec) / 8)
        }
      }
    }

    const structFp = computeManifestStructureFingerprint(parsed)

    const media: DetectedMedia = {
      id,
      tabId: ctx.tabId,
      type: parsed.type,
      url: payload.manifestUrl,
      sourcePageUrl,
      frameUrl: effectiveFrameUrl,
      title: this.cleanStreamTitle(tabTitle, payload.manifestUrl),
      thumbnail: ctx.lastPoster,
      durationSec,
      sizeBytes: parsed.videoTracks[0]?.estimatedBytes,
      containerHint: 'mp4',
      isLive: parsed.isLive,
      isEncryptedAes128: parsed.isEncryptedAes128,
      isDrmProtected: parsed.isDrmProtected,
      drmSystem: parsed.drmSystem,
      videoTracks: parsed.videoTracks,
      audioTracks: parsed.audioTracks,
      subtitleTracks: parsed.subtitleTracks,
      requestHeaders: cleanHeaders,
      partition: ctx.partition,
      localManifestPath,
      baseUrl: baseDirUrl,
      mediaSignature: computeMediaSignature(
        parsed.type,
        payload.manifestUrl.startsWith('blob:') ? effectiveFrameUrl : payload.manifestUrl,
        structFp
      ),
      capturedAt: Date.now()
    }

    diagLogger.log(
      'MANIFEST_PARSED',
      'stream_recorded',
      {
        id,
        type: parsed.type,
        isMaster: parsed.isMaster,
        durationSec,
        segmentCount: parsed.segmentCount,
        videoTracks: parsed.videoTracks,
        audioTracks: parsed.audioTracks,
        subtitleTracks: parsed.subtitleTracks,
        localManifestPath,
        frameUrl: effectiveFrameUrl,
        sourcePageUrl
      },
      { tabId: ctx.tabId, url: payload.manifestUrl }
    )

    this.recordDetectedMedia(ctx.tabId, media)
  }

  private enrichMasterFromChildVariant(
    tabId: string,
    masterId: string,
    childParsed: ParsedManifestResult
  ): void {
    const list = this.mediaByTabId.get(tabId)
    if (!list) return
    const master = list.find((m) => m.id === masterId)
    if (!master) return

    let changed = false
    if (childParsed.durationSec && (!master.durationSec || childParsed.durationSec > master.durationSec)) {
      master.durationSec = childParsed.durationSec
      for (const vt of master.videoTracks) {
        if (vt.bandwidth) {
          vt.estimatedBytes = Math.round((vt.bandwidth * childParsed.durationSec) / 8)
        }
      }
      master.sizeBytes = master.videoTracks[0]?.estimatedBytes || master.sizeBytes
      changed = true
    }
    if (childParsed.isEncryptedAes128 && !master.isEncryptedAes128) {
      master.isEncryptedAes128 = true
      changed = true
    }

    if (changed) {
      this.onTabMediaChanged?.(tabId, this.getMediaForTab(tabId))
    }
  }

  private async captureDirectMediaFromResponse(
    ctx: AttachedTabContext,
    info: PendingRequestInfo
  ): Promise<void> {
    const sess = this.sessionManager.getSessionByPartition(ctx.partition)
    const sourcePageUrl = ctx.getTabState()?.url || ctx.webContents.getURL() || info.url
    const effectiveFrameUrl =
      info.frameUrl && info.frameUrl.startsWith('http') ? info.frameUrl : sourcePageUrl
    const cookieHeader = await CookieExporter.getCookieHeaderForUrl(sess, info.url)

    const cleanHeaders: Record<string, string> = {
      'User-Agent': info.headers['user-agent'] || sess.getUserAgent()
    }
    if (info.headers.referer) cleanHeaders.Referer = info.headers.referer
    if (info.headers.origin) cleanHeaders.Origin = info.headers.origin
    if (info.headers.authorization) cleanHeaders.Authorization = info.headers.authorization
    if (cookieHeader) cleanHeaders.Cookie = cookieHeader

    const extMatch = /\.([a-z0-9]{2,4})(\?|#|$)/i.exec(info.url)
    const ext = extMatch ? extMatch[1].toLowerCase() : info.mimeType?.includes('audio') ? 'mp3' : 'mp4'
    const tabTitle = ctx.getTabState()?.title || ctx.lastPageTitle || 'Direct Media'

    const media: DetectedMedia = {
      id: crypto.randomUUID(),
      tabId: ctx.tabId,
      type: 'direct',
      url: info.url,
      sourcePageUrl,
      frameUrl: effectiveFrameUrl,
      title: this.cleanStreamTitle(tabTitle, info.url),
      thumbnail: ctx.lastPoster,
      sizeBytes: info.contentLength || undefined,
      mimeType: info.mimeType,
      containerHint: ext,
      isDrmProtected: false,
      videoTracks: [
        {
          id: 'direct-original',
          label: `Original Direct File (.${ext.toUpperCase()})${
            info.contentLength
              ? ` • ${(info.contentLength / (1024 * 1024)).toFixed(1)} MB`
              : ''
          }`,
          estimatedBytes: info.contentLength || undefined
        }
      ],
      audioTracks: [],
      subtitleTracks: [],
      requestHeaders: cleanHeaders,
      partition: ctx.partition,
      mediaSignature: computeMediaSignature('direct', info.url, String(info.contentLength || 0)),
      capturedAt: Date.now()
    }

    diagLogger.log(
      'MANIFEST_PARSED',
      'direct_media_recorded',
      {
        id: media.id,
        mimeType: info.mimeType,
        sizeBytes: info.contentLength,
        frameUrl: effectiveFrameUrl,
        sourcePageUrl
      },
      { tabId: ctx.tabId, url: info.url }
    )

    this.recordDetectedMedia(ctx.tabId, media)
  }

  private registerInternalPreloadIpc(): void {
    ipcMain.on(
      IPC_CHANNELS.INTERNAL_SNIFFER_BLOB,
      (
        event,
        detail: {
          manifestText: string
          blobUrl: string
          kind: 'hls' | 'dash'
          frameUrl: string
          pageTitle: string
        }
      ) => {
        const tabId = this.tabIdByWcId.get(event.sender.id)
        if (!tabId) return
        const ctx = this.contextsByTabId.get(tabId)
        if (!ctx || !detail?.manifestText) return

        const dumpPath = diagLogger.dumpRawArtifact(`preload_${detail.kind}`, 'txt', detail.manifestText)
        diagLogger.log(
          'PRELOAD_HOOK',
          'preload_manifest_captured',
          {
            kind: detail.kind,
            blobUrl: detail.blobUrl,
            frameUrl: detail.frameUrl,
            length: detail.manifestText.length,
            dumpPath,
            head: detail.manifestText.slice(0, 300)
          },
          { tabId, url: detail.blobUrl }
        )

        void this.ingestManifestPayload(ctx, {
          rawText: detail.manifestText,
          manifestUrl: detail.blobUrl || `blob:${detail.frameUrl}`,
          frameUrl: detail.frameUrl,
          requestHeaders: {},
          pageTitleHint: detail.pageTitle
        })
      }
    )

    ipcMain.on(
      IPC_CHANNELS.INTERNAL_SNIFFER_DIAG,
      (
        event,
        detail: {
          category: LogCategory
          event: string
          data: Record<string, unknown>
        }
      ) => {
        const tabId = this.tabIdByWcId.get(event.sender.id)
        if (!detail) return
        diagLogger.log(
          detail.category || 'PRELOAD_HOOK',
          detail.event || 'preload_diag',
          detail.data,
          { tabId, url: String(detail.data?.frameUrl || '') }
        )
      }
    )

    ipcMain.on(
      IPC_CHANNELS.INTERNAL_SNIFFER_VIDEO_META,
      (
        event,
        detail: {
          durationSec?: number
          videoWidth?: number
          videoHeight?: number
          poster?: string
          pageTitle?: string
        }
      ) => {
        const tabId = this.tabIdByWcId.get(event.sender.id)
        if (!tabId) return
        const ctx = this.contextsByTabId.get(tabId)
        if (!ctx) return

        if (detail.durationSec && detail.durationSec > 0) {
          ctx.lastDurationSec = detail.durationSec
        }
        if (detail.videoHeight && detail.videoHeight > 0) {
          ctx.lastVideoHeight = detail.videoHeight
          ctx.lastVideoWidth = detail.videoWidth
        }
        if (detail.poster) {
          ctx.lastPoster = detail.poster
        }
        if (detail.pageTitle) {
          ctx.lastPageTitle = detail.pageTitle
        }

        // Update Master playlists (which lack #EXTINF duration) when the main episode (>45s) starts playing!
        const list = this.mediaByTabId.get(tabId)
        if (list && list.length > 0) {
          let mutated = false
          for (const item of list) {
            if (
              detail.durationSec &&
              detail.durationSec > 45 &&
              (!item.durationSec || (item.videoTracks.length > 1 && item.durationSec < 45))
            ) {
              item.durationSec = detail.durationSec
              for (const vt of item.videoTracks) {
                if (vt.bandwidth) {
                  vt.estimatedBytes = Math.round((vt.bandwidth * detail.durationSec) / 8)
                }
              }
              item.sizeBytes = item.videoTracks[0]?.estimatedBytes || item.sizeBytes
              mutated = true
            }
            if (!item.thumbnail && ctx.lastPoster) {
              item.thumbnail = ctx.lastPoster
              mutated = true
            }
          }
          if (mutated) {
            this.onTabMediaChanged?.(tabId, this.getMediaForTab(tabId))
          }
        }
      }
    )
  }

  private recordDetectedMedia(tabId: string, media: DetectedMedia): void {
    const list = this.mediaByTabId.get(tabId) || []

    const existingIdx = list.findIndex((m) => m.mediaSignature === media.mediaSignature)

    if (existingIdx >= 0) {
      const prev = list[existingIdx]
      list[existingIdx] = {
        ...media,
        id: prev.id,
        durationSec: media.durationSec || prev.durationSec,
        sizeBytes: media.sizeBytes || prev.sizeBytes,
        thumbnail: media.thumbnail || prev.thumbnail
      }
    } else {
      list.unshift(media)
    }

    this.mediaByTabId.set(tabId, list)
    const sorted = this.sortAndFlagStreams(list)
    this.onTabMediaChanged?.(tabId, sorted)

    for (const listener of this.mediaListeners) {
      try {
        listener(media)
      } catch {
        // ignore
      }
    }
  }

  /**
   * Ranks genuine full-length episodes & multi-resolution Master streams FIRST,
   * and demotes short (< 45s) / tiny (< 10 MB) pre-roll ad streams to the bottom with isLikelyAdClip = true!
   */
  private sortAndFlagStreams(list: DetectedMedia[]): DetectedMedia[] {
    const hasLongOrMasterStream = list.some(
      (m) =>
        (m.durationSec && m.durationSec >= 60) ||
        m.videoTracks.length > 1 ||
        (m.videoTracks[0]?.height && m.videoTracks[0].height >= 1080) ||
        (m.sizeBytes && m.sizeBytes > 25 * 1024 * 1024)
    )

    const annotated = list.map((m) => {
      const isShortClip =
        Boolean(m.durationSec && m.durationSec > 0 && m.durationSec <= 45) ||
        Boolean(m.type === 'direct' && m.sizeBytes && m.sizeBytes < 8 * 1024 * 1024)

      return {
        ...m,
        isLikelyAdClip: hasLongOrMasterStream && isShortClip
      }
    })

    annotated.sort((a, b) => {
      if (Boolean(a.isLikelyAdClip) !== Boolean(b.isLikelyAdClip)) {
        return a.isLikelyAdClip ? 1 : -1
      }
      const aMaxH = a.videoTracks[0]?.height || 0
      const bMaxH = b.videoTracks[0]?.height || 0
      if (a.type !== 'direct' && b.type === 'direct') return -1
      if (a.type === 'direct' && b.type !== 'direct') return 1
      if ((b.durationSec || 0) !== (a.durationSec || 0)) {
        return (b.durationSec || 0) - (a.durationSec || 0)
      }
      if (bMaxH !== aMaxH) return bMaxH - aMaxH
      return b.capturedAt - a.capturedAt
    })

    return annotated
  }

  private normalizeHeaderMap(raw: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined && v !== null) {
        out[k.toLowerCase()] = Array.isArray(v) ? v.join('; ') : String(v)
      }
    }
    return out
  }

  private parseTotalContentLength(contentLength?: string, contentRange?: string): number {
    if (contentRange) {
      const slashIdx = contentRange.lastIndexOf('/')
      if (slashIdx >= 0) {
        const total = Number(contentRange.slice(slashIdx + 1).trim())
        if (Number.isFinite(total) && total > 0) return total
      }
    }
    const len = Number(contentLength || 0)
    return Number.isFinite(len) && len > 0 ? len : 0
  }

  private cleanStreamTitle(pageTitle: string, fallbackUrl: string): string {
    const cleaned = pageTitle
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*[-|•]\s*(YouTube|Vimeo|Twitch|Watch.*Online.*)$/i, '')
      .trim()
    if (cleaned && cleaned !== 'New Tab' && !cleaned.startsWith('http')) {
      return cleaned.slice(0, 140)
    }
    try {
      const u = new URL(fallbackUrl.startsWith('blob:') ? fallbackUrl.slice(5) : fallbackUrl)
      const base = path.basename(u.pathname).replace(/\.(m3u8|mpd|mp4|mkv|txt)$/i, '')
      return base && base !== 'master' && base !== 'index' ? base : u.hostname
    } catch {
      return 'Captured Video Stream'
    }
  }
}
