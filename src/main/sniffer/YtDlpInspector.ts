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
import { computeCleanChromeUserAgent } from '../browser/StealthNormalizer'
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
    // Skip bare homepages so we only probe actual media/watch URLs automatically
    if (
      (host === 'youtube.com' || host === 'm.youtube.com') &&
      (parsed.pathname === '/' || parsed.pathname.startsWith('/results'))
    ) {
      return false
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
      const rawJson = await new Promise<string>((resolve, reject) => {
        const args = [
          '--dump-single-json',
          '--no-playlist',
          '--no-warnings',
          '--cookies',
          cookieJarPath,
          '--user-agent',
          computeCleanChromeUserAgent(),
          opts.url
        ]

        const proc = spawn(ytdlpRes.path!, args, { windowsHide: true })
        let stdout = ''
        let stderr = ''

        const timer = setTimeout(() => {
          proc.kill()
          reject(new Error('yt-dlp metadata probe timed out'))
        }, 25000)

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

      // Extract distinct audio language tracks if offered (e.g., multi-language YouTube tracks)
      const seenLangs = new Set<string>()
      const audioTracks: AudioTrackOption[] = []
      for (const f of formats) {
        const isAudioOnly = (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none'
        if (!isAudioOnly) continue
        const lang = f.language || 'default'
        if (seenLangs.has(lang)) continue
        seenLangs.add(lang)
        audioTracks.push({
          id: `ytdlp-a-${lang}`,
          label: lang === 'default' ? 'Default Audio (Best)' : `Audio (${lang})`,
          language: lang === 'default' ? undefined : lang,
          codecs: f.acodec,
          selector:
            lang === 'default' ? 'bestaudio' : `bestaudio[language=${lang}]/bestaudio`
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
    } catch {
      return null
    } finally {
      await fs.promises.rm(cookieJarPath, { force: true }).catch(() => {})
    }
  }
}
