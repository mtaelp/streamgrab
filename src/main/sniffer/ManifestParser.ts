import { XMLParser } from 'fast-xml-parser'
import type {
  AudioTrackOption,
  SubtitleTrackOption,
  VideoTrackOption
} from '@shared/types'

export interface ParsedManifestResult {
  type: 'hls' | 'dash'
  isMaster: boolean
  isLive: boolean
  durationSec?: number
  isEncryptedAes128: boolean
  isDrmProtected: boolean
  drmSystem?: string
  videoTracks: VideoTrackOption[]
  audioTracks: AudioTrackOption[]
  subtitleTracks: SubtitleTrackOption[]
  normalizedManifestText: string
  segmentCount: number
}

const WIDEVINE_UUID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'
const PLAYREADY_UUID = '9a04f079-9840-4286-ab92-e65be0885f95'
const FAIRPLAY_SCHEME = 'com.apple.streamingkeydelivery'

export function parseIso8601Duration(iso?: string): number | undefined {
  if (!iso || typeof iso !== 'string') return undefined
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(iso.trim())
  if (!match) return undefined
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  const minutes = Number(match[3] || 0)
  const seconds = Number(match[4] || 0)
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds
  return total > 0 ? Math.round(total) : undefined
}

export function resolveAgainstBase(uri: string, baseUrl?: string): string {
  const trimmed = uri.trim()
  if (!trimmed || !baseUrl) return trimmed
  if (/^(https?:|data:|skd:|urn:)/i.test(trimmed)) return trimmed
  try {
    // Strip blob: prefix if baseUrl came from a blob:https://origin/... URL
    const cleanBase = baseUrl.startsWith('blob:') ? baseUrl.slice(5) : baseUrl
    return new URL(trimmed, cleanBase).href
  } catch {
    return trimmed
  }
}

function parseHlsAttributeList(attrLine: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const regex = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(attrLine)) !== null) {
    const key = match[1].toUpperCase()
    const val = match[3] !== undefined ? match[3] : match[4]
    attrs[key] = val.trim()
  }
  return attrs
}

function formatBitrate(bps?: number): string {
  if (!bps || bps <= 0) return ''
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

function friendlyCodecLabel(codecs?: string): string {
  if (!codecs) return ''
  const parts: string[] = []
  if (/avc1/i.test(codecs)) parts.push('H.264')
  else if (/hev1|hvc1/i.test(codecs)) parts.push('HEVC')
  else if (/av01/i.test(codecs)) parts.push('AV1')
  else if (/vp0?9/i.test(codecs)) parts.push('VP9')

  if (/mp4a/i.test(codecs)) parts.push('AAC')
  else if (/opus/i.test(codecs)) parts.push('Opus')
  else if (/ec-3|ac-3/i.test(codecs)) parts.push('Dolby')

  return parts.length > 0 ? parts.join('+') : codecs
}

export function normalizeHlsManifestUrls(manifestText: string, baseUrl?: string): string {
  if (!baseUrl) return manifestText
  const lines = manifestText.split(/\r?\n/)
  const normalized = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return line

    // Rewrite URI="..." inside #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/gi, (_full, innerUri: string) => {
        return `URI="${resolveAgainstBase(innerUri, baseUrl)}"`
      })
    }

    return resolveAgainstBase(trimmed, baseUrl)
  })
  return normalized.join('\n')
}

export function parseHlsManifest(manifestText: string, baseUrl?: string): ParsedManifestResult {
  const normalizedManifestText = normalizeHlsManifestUrls(manifestText, baseUrl)
  const lines = normalizedManifestText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  const videoTracks: VideoTrackOption[] = []
  const audioTracks: AudioTrackOption[] = []
  const subtitleTracks: SubtitleTrackOption[] = []

  let isMaster = false
  let hasEndList = false
  let totalDuration = 0
  let segmentCount = 0
  let isEncryptedAes128 = false
  let isDrmProtected = false
  let drmSystem: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true
    } else if (line.startsWith('#EXTINF:')) {
      const durStr = line.slice(8).split(',')[0]
      const dur = parseFloat(durStr)
      if (Number.isFinite(dur) && dur > 0) {
        totalDuration += dur
      }
      segmentCount += 1
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attrs = parseHlsAttributeList(line.slice(line.indexOf(':') + 1))
      const method = (attrs.METHOD || '').toUpperCase()
      const keyFormat = (attrs.KEYFORMAT || '').toLowerCase()

      if (
        keyFormat.includes(WIDEVINE_UUID) ||
        keyFormat.includes('widevine')
      ) {
        isDrmProtected = true
        drmSystem = 'Widevine'
      } else if (keyFormat.includes(PLAYREADY_UUID) || keyFormat.includes('playready')) {
        isDrmProtected = true
        drmSystem = 'PlayReady'
      } else if (keyFormat.includes(FAIRPLAY_SCHEME) || method === 'SAMPLE-AES-CTR') {
        isDrmProtected = true
        drmSystem = 'FairPlay / CENC'
      } else if (method === 'AES-128') {
        isEncryptedAes128 = true
      }
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      isMaster = true
      const attrs = parseHlsAttributeList(line.slice(13))
      const mediaType = (attrs.TYPE || '').toUpperCase()
      const lang = attrs.LANGUAGE || ''
      const name = attrs.NAME || lang || 'Track'
      const isDefault = (attrs.DEFAULT || '').toUpperCase() === 'YES'

      if (mediaType === 'AUDIO') {
        const id = `audio-${audioTracks.length}-${lang || name}`
        audioTracks.push({
          id,
          label: `${name}${lang && !name.includes(lang) ? ` (${lang})` : ''}${isDefault ? ' • Default' : ''}`,
          language: lang || undefined,
          name,
          isDefault,
          // IMPORTANT: Do NOT wrap regex values in literal double quotes when passing via child_process.spawn!
          selector: lang ? `lang=${lang}:for=best` : 'for=best'
        })
      } else if (mediaType === 'SUBTITLES') {
        const id = `sub-${subtitleTracks.length}-${lang || name}`
        subtitleTracks.push({
          id,
          label: `${name}${lang && !name.includes(lang) ? ` (${lang})` : ''}`,
          language: lang || undefined,
          name,
          uri: attrs.URI,
          selector: lang ? `lang=${lang}:for=all` : 'for=all'
        })
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true
      const attrs = parseHlsAttributeList(line.slice(18))
      const bandwidth = Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH || 0) || undefined
      const fps = attrs['FRAME-RATE'] ? Math.round(Number(attrs['FRAME-RATE'])) : undefined
      const codecs = attrs.CODECS
      let width: number | undefined
      let height: number | undefined
      if (attrs.RESOLUTION && attrs.RESOLUTION.includes('x')) {
        const [w, h] = attrs.RESOLUTION.split('x').map(Number)
        if (w > 0 && h > 0) {
          width = w
          height = h
        }
      }

      const resLabel = height ? `${height}p${fps && fps > 30 ? fps : ''}` : 'Auto / Variant'
      const codecTxt = friendlyCodecLabel(codecs)
      const bwTxt = formatBitrate(bandwidth)
      const labelParts = [
        width && height ? `${resLabel} (${width}x${height})` : resLabel,
        codecTxt,
        bwTxt
      ].filter(Boolean)

      // IMPORTANT: child_process.spawn passes arguments verbatim without shell quote stripping,
      // so never put literal "..." around regex patterns for N_m3u8DL-RE!
      const selector =
        width && height
          ? `res=${width}x${height}:for=best`
          : height
            ? `res=.*x${height}:for=best`
            : bandwidth
              ? `bwMin=${Math.max(1, Math.floor(bandwidth / 1000 - 20))}:for=best`
              : 'best'

      videoTracks.push({
        id: `v-${videoTracks.length}-${height || bandwidth || 0}`,
        label: labelParts.join(' • '),
        width,
        height,
        fps,
        bandwidth,
        codecs,
        selector
      })
    }
  }

  // Sort video tracks highest resolution / bandwidth first and deduplicate identical labels
  videoTracks.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))

  if (videoTracks.length === 0) {
    videoTracks.push({
      id: 'best',
      label: 'Best Available Stream Quality',
      selector: 'best'
    })
  }

  const durationSec = totalDuration > 0 ? Math.round(totalDuration) : undefined
  if (durationSec) {
    for (const vt of videoTracks) {
      if (vt.bandwidth) {
        vt.estimatedBytes = Math.round((vt.bandwidth * durationSec) / 8)
      }
    }
  }

  const isLive = !isMaster && segmentCount > 0 && !hasEndList

  return {
    type: 'hls',
    isMaster,
    isLive,
    durationSec,
    isEncryptedAes128,
    isDrmProtected,
    drmSystem,
    videoTracks,
    audioTracks,
    subtitleTracks,
    normalizedManifestText,
    segmentCount
  }
}

function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (!val) return []
  return Array.isArray(val) ? val : [val]
}

export function parseDashManifest(manifestText: string, baseUrl?: string): ParsedManifestResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_'
  })

  const parsed = parser.parse(manifestText) as Record<string, unknown>
  const mpd = (parsed.MPD || parsed['mpd:MPD'] || {}) as Record<string, unknown>

  const mpdType = String(mpd['@_type'] || 'static').toLowerCase()
  const isLive = mpdType === 'dynamic'
  const durationSec = parseIso8601Duration(mpd['@_mediaPresentationDuration'] as string | undefined)

  let isDrmProtected = false
  let drmSystem: string | undefined

  const rawLower = manifestText.toLowerCase()
  if (rawLower.includes(WIDEVINE_UUID)) {
    isDrmProtected = true
    drmSystem = 'Widevine'
  } else if (rawLower.includes(PLAYREADY_UUID)) {
    isDrmProtected = true
    drmSystem = 'PlayReady'
  } else if (rawLower.includes('cenc:pssh') && rawLower.includes('contentprotection')) {
    isDrmProtected = true
    drmSystem = 'CENC DRM'
  }

  const videoTracks: VideoTrackOption[] = []
  const audioTracks: AudioTrackOption[] = []
  const subtitleTracks: SubtitleTrackOption[] = []

  const periods = asArray<Record<string, unknown>>(
    mpd.Period as Record<string, unknown> | Array<Record<string, unknown>> | undefined
  )
  for (const period of periods) {
    const adaptationSets = asArray<Record<string, unknown>>(
      period.AdaptationSet as Record<string, unknown> | Array<Record<string, unknown>> | undefined
    )
    for (const adapt of adaptationSets) {
      const contentType = String(adapt['@_contentType'] || '').toLowerCase()
      const mimeType = String(adapt['@_mimeType'] || '').toLowerCase()
      const lang = String(adapt['@_lang'] || '')

      const representations = asArray<Record<string, unknown>>(
        adapt.Representation as Record<string, unknown> | Array<Record<string, unknown>> | undefined
      )

      const isVideo = contentType === 'video' || mimeType.startsWith('video/')
      const isAudio = contentType === 'audio' || mimeType.startsWith('audio/')
      const isText =
        contentType === 'text' ||
        mimeType.includes('vtt') ||
        mimeType.includes('ttml') ||
        mimeType.includes('subtitle')

      if (isVideo) {
        for (const rep of representations) {
          const width = Number(rep['@_width'] || adapt['@_width'] || 0) || undefined
          const height = Number(rep['@_height'] || adapt['@_height'] || 0) || undefined
          const bandwidth = Number(rep['@_bandwidth'] || 0) || undefined
          const codecs = String(rep['@_codecs'] || adapt['@_codecs'] || '') || undefined
          const fpsRaw = String(rep['@_frameRate'] || adapt['@_frameRate'] || '')
          let fps: number | undefined
          if (fpsRaw.includes('/')) {
            const [n, d] = fpsRaw.split('/').map(Number)
            if (n > 0 && d > 0) fps = Math.round(n / d)
          } else if (Number(fpsRaw) > 0) {
            fps = Math.round(Number(fpsRaw))
          }

          const resTxt = height ? `${height}p${fps && fps > 30 ? fps : ''}` : 'Video Stream'
          const label = [
            width && height ? `${resTxt} (${width}x${height})` : resTxt,
            friendlyCodecLabel(codecs),
            formatBitrate(bandwidth)
          ]
            .filter(Boolean)
            .join(' • ')

          videoTracks.push({
            id: `dash-v-${videoTracks.length}-${rep['@_id'] || height || 0}`,
            label,
            width,
            height,
            fps,
            bandwidth,
            codecs,
            estimatedBytes:
              bandwidth && durationSec ? Math.round((bandwidth * durationSec) / 8) : undefined,
            selector:
              width && height
                ? `res=${width}x${height}:for=best`
                : height
                  ? `res=.*x${height}:for=best`
                  : 'best'
          })
        }
      } else if (isAudio) {
        for (const rep of representations) {
          const bandwidth = Number(rep['@_bandwidth'] || 0) || undefined
          const codecs = String(rep['@_codecs'] || adapt['@_codecs'] || '') || undefined
          const label = [
            lang || 'Audio',
            friendlyCodecLabel(codecs),
            formatBitrate(bandwidth)
          ]
            .filter(Boolean)
            .join(' • ')

          audioTracks.push({
            id: `dash-a-${audioTracks.length}-${lang || rep['@_id'] || 0}`,
            label,
            language: lang || undefined,
            codecs,
            bandwidth,
            selector: lang ? `lang=${lang}:for=best` : 'best'
          })
        }
      } else if (isText) {
        subtitleTracks.push({
          id: `dash-s-${subtitleTracks.length}-${lang || 0}`,
          label: lang ? `Subtitles (${lang})` : 'Subtitles',
          language: lang || undefined,
          selector: lang ? `lang=${lang}:for=all` : 'all'
        })
      }
    }
  }

  videoTracks.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0))
  if (videoTracks.length === 0) {
    videoTracks.push({ id: 'best', label: 'Best Available DASH Video', selector: 'best' })
  }

  // Inject <BaseURL> into MPD if missing so local MPD files resolve relative segment templates cleanly
  let normalizedManifestText = manifestText
  if (baseUrl && !/<BaseURL>/i.test(manifestText)) {
    const cleanBase = (baseUrl.startsWith('blob:') ? baseUrl.slice(5) : baseUrl).replace(
      /\/[^/?#]*([?#].*)?$/,
      '/'
    )
    normalizedManifestText = manifestText.replace(
      /(<MPD\b[^>]*>)/i,
      `$1\n  <BaseURL>${cleanBase}</BaseURL>`
    )
  }

  return {
    type: 'dash',
    isMaster: true,
    isLive,
    durationSec,
    isEncryptedAes128: false,
    isDrmProtected,
    drmSystem,
    videoTracks,
    audioTracks,
    subtitleTracks,
    normalizedManifestText,
    segmentCount: 0
  }
}

export function detectAndParseManifest(
  text: string,
  baseUrl?: string
): ParsedManifestResult | null {
  const head = text.slice(0, 1024).trimStart()
  if (head.startsWith('#EXTM3U')) {
    return parseHlsManifest(text, baseUrl)
  }
  if (head.includes('<MPD') || (head.startsWith('<?xml') && text.slice(0, 4096).includes('<MPD'))) {
    return parseDashManifest(text, baseUrl)
  }
  return null
}
