import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Session } from 'electron'
import type {
  AudioTrackOption,
  DetectedMedia,
  SubtitleTrackOption,
  VideoTrackOption
} from '@shared/types'
import type { BinaryManager } from '../binaries/BinaryManager'
import {
  getCachedNoCheckCertificates,
  isTlsCertVerifyError,
  markNeedsNoCheckCertificates,
  resolveYtDlpNodeRuntimeArg
} from '../binaries/YtDlpRuntimeHelper'
import { computeCleanChromeUserAgent } from '../browser/StealthNormalizer'
import { diagLogger } from '../logger/DiagnosticLogger'
import { CookieExporter } from './CookieExporter'

const CIPHER_EXTRACTOR_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'twitch.tv',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'bilibili.com',
  'dailymotion.com',
  'soundcloud.com',
  'reddit.com'
]

export function isKnownExtractorSite(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!CIPHER_EXTRACTOR_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
      return false
    }
    // Skip bare homepages / search / feed pages so we only auto-probe actual video/watch/shorts URLs
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (
        parsed.pathname === '/' ||
        parsed.pathname.startsWith('/results') ||
        parsed.pathname.startsWith('/feed') ||
        parsed.pathname.startsWith('/@') ||
        parsed.pathname.startsWith('/channel/')
      ) {
        return false
      }
      if (parsed.pathname === '/watch' && !parsed.searchParams.get('v')) {
        return false
      }
    }
    return parsed.pathname.length > 1
  } catch {
    return false
  }
}

interface YtDlpFormatJson {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
  fps?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
  language?: string
  language_preference?: number
  format_note?: string
}

interface YtDlpSingleJson {
  id?: string
  title?: string
  thumbnail?: string
  duration?: number
  is_live?: boolean
  webpage_url?: string
  formats?: YtDlpFormatJson[]
  subtitles?: Record<string, Array<{ ext?: string; name?: string }>>
}

export class YtDlpInspector {
  private binaries: BinaryManager

  constructor(binaries: BinaryManager) {
    this.binaries = binaries
  }

  private runDumpSingleJson(
    ytdlpPath: string,
    cookieJarPath: string,
    url: string,
    noCheckCert: boolean
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = ['--dump-single-json', '--no-playlist', '--no-warnings']
      const jsRuntimeArg = resolveYtDlpNodeRuntimeArg()
      if (jsRuntimeArg) {
        args.push('--js-runtimes', jsRuntimeArg)
      }
      if (noCheckCert) {
        args.push('--no-check-certificates')
      }
      args.push('--cookies', cookieJarPath, '--user-agent', computeCleanChromeUserAgent(), url)

      const proc = spawn(ytdlpPath, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('yt-dlp metadata probe timed out'))
      }, 28000)

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) {
          resolve(stdout)
        } else {
          reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`))
        }
      })
    })
  }

  public async inspectUrl(opts: {
    url: string
    tabId: string
    partition: string
    session: Session
  }): Promise<DetectedMedia | null> {
    const ytdlpRes = this.binaries.resolveBinaryPath('yt-dlp')
    if (!ytdlpRes.path) return null

    const cookieJarPath = await CookieExporter.exportNetscapeCookieJar(opts.session, [opts.url])

    try {
      let rawJson: string
      try {
        rawJson = await this.runDumpSingleJson(
          ytdlpRes.path,
          cookieJarPath,
          opts.url,
          getCachedNoCheckCertificates()
        )
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        if (!getCachedNoCheckCertificates() && isTlsCertVerifyError(msg)) {
          // Local OS Root CA / Antivirus HTTPS shield (e.g. Avast WebShield) not in PyInstaller certifi bundle
          markNeedsNoCheckCertificates()
          diagLogger.log(
            'MANIFEST_PARSED',
            'ytdlp_tls_fallback_retry',
            { reason: msg.slice(0, 240) },
            { tabId: opts.tabId, url: opts.url }
          )
          rawJson = await this.runDumpSingleJson(ytdlpRes.path, cookieJarPath, opts.url, true)
        } else {
          throw firstErr
        }
      }

      const info = JSON.parse(rawJson) as YtDlpSingleJson
      const formats = info.formats || []
      if (formats.length === 0) return null

      // Group best video format per height for a clean resolution picker
      const byHeight = new Map<number, YtDlpFormatJson>()
      for (const f of formats) {
        const hasVideo = f.vcodec && f.vcodec !== 'none'
        if (!hasVideo || !f.height || f.height < 144) continue
        const existing = byHeight.get(f.height)
        if (!existing || (f.tbr || 0) > (existing.tbr || 0)) {
          byHeight.set(f.height, f)
        }
      }

      const heights = Array.from(byHeight.keys()).sort((a, b) => b - a)
      const videoTracks: VideoTrackOption[] = heights.map((h) => {
        const f = byHeight.get(h)!
        const estBytes = f.filesize || f.filesize_approx
        const fpsLabel = f.fps && f.fps > 30 ? `${Math.round(f.fps)}fps` : ''
        return {
          id: `ytdlp-${h}p`,
          label: [
            `${h}p${fpsLabel ? ` (${fpsLabel})` : ''}`,
            f.vcodec?.split('.')[0]?.toUpperCase(),
            estBytes ? `~${(estBytes / (1024 * 1024)).toFixed(1)} MB` : undefined
          ]
            .filter(Boolean)
            .join(' • '),
          width: f.width,
          height: h,
          fps: f.fps ? Math.round(f.fps) : undefined,
          codecs: f.vcodec,
          estimatedBytes: estBytes,
          selector: `bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`
        }
      })

      if (videoTracks.length === 0) {
        videoTracks.push({
          id: 'ytdlp-best',
          label: 'Best Available Quality',
          selector: 'bestvideo+bestaudio/best'
        })
      }

      // Extract distinct audio language tracks (prioritizing creator's original track ahead of AI dubs)
      const audioFormats = formats
        .filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
        .sort((a, b) => {
          const prefDiff = (b.language_preference ?? 0) - (a.language_preference ?? 0)
          if (prefDiff !== 0) return prefDiff
          const aOrig = /original/i.test(a.format_note || '') ? 1 : 0
          const bOrig = /original/i.test(b.format_note || '') ? 1 : 0
          if (bOrig !== aOrig) return bOrig - aOrig
          return (b.tbr ?? 0) - (a.tbr ?? 0)
        })

      const seenLangs = new Set<string>()
      const audioTracks: AudioTrackOption[] = []
      for (const f of audioFormats) {
        const lang = f.language || 'default'
        if (seenLangs.has(lang)) continue
        seenLangs.add(lang)
        const isOriginal =
          (f.language_preference ?? 0) > 0 || /original/i.test(f.format_note || '')
        audioTracks.push({
          id: `ytdlp-a-${lang}`,
          label:
            lang === 'default'
              ? 'Default Audio (Best)'
              : `Audio (${lang})${isOriginal ? ' • Original' : ''}`,
          language: lang === 'default' ? undefined : lang,
          codecs: f.acodec,
          isDefault: audioTracks.length === 0,
          selector:
            lang === 'default' ? 'bestaudio' : `bestaudio[language=${lang}]`
        })
      }

      const subtitleTracks: SubtitleTrackOption[] = Object.entries(info.subtitles || {})
        .filter(([lang]) => lang !== 'live_chat')
        .slice(0, 25)
        .map(([lang, items]) => ({
          id: `ytdlp-sub-${lang}`,
          label: items[0]?.name ? `${items[0].name} (${lang})` : lang,
          language: lang,
          selector: lang
        }))

      diagLogger.log(
        'MANIFEST_PARSED',
        'ytdlp_stream_detected',
        {
          title: info.title,
          durationSec: info.duration,
          heights,
          audioCount: audioTracks.length,
          subtitleCount: subtitleTracks.length
        },
        { tabId: opts.tabId, url: opts.url }
      )

      return {
        id: crypto.randomUUID(),
        tabId: opts.tabId,
        type: 'ytdlp',
        url: info.webpage_url || opts.url,
        sourcePageUrl: opts.url,
        frameUrl: opts.url,
        title: info.title || 'Extracted Video Stream',
        thumbnail: info.thumbnail,
        durationSec: info.duration ? Math.round(info.duration) : undefined,
        sizeBytes: videoTracks[0]?.estimatedBytes,
        isLive: Boolean(info.is_live),
        isDrmProtected: false,
        videoTracks,
        audioTracks,
        subtitleTracks,
        requestHeaders: {
          'User-Agent': computeCleanChromeUserAgent(),
          Referer: opts.url
        },
        partition: opts.partition,
        mediaSignature: `ytdlp:${info.id || opts.url}`,
        capturedAt: Date.now()
      }
    } catch (err) {
      diagLogger.log(
        'MANIFEST_PARSED',
        'ytdlp_inspect_error',
        { error: err instanceof Error ? err.message.slice(0, 400) : String(err) },
        { tabId: opts.tabId, url: opts.url }
      )
      return null
    } finally {
      await fs.promises.rm(cookieJarPath, { force: true }).catch(() => {})
    }
  }
}
