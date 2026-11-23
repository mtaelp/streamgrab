import { describe, expect, it } from 'vitest'
import {
  detectAndParseManifest,
  parseDashManifest,
  parseHlsManifest,
  parseIso8601Duration
} from '../src/main/sniffer/ManifestParser'

describe('ManifestParser (HLS & MPEG-DASH)', () => {
  it('parses HLS Master playlists, audio/subtitle tracks, and rewrites relative URIs', () => {
    const rawMaster = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="en",NAME="English",DEFAULT=YES,URI="audio/en/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="ja",NAME="Japanese",DEFAULT=NO,URI="audio/ja/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English CC",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
video/1080p/playlist.m3u8?sig=abc
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
../720p/playlist.m3u8
`
    const parsed = parseHlsManifest(rawMaster, 'https://cdn.example.com/streams/movie/master.m3u8')

    expect(parsed.type).toBe('hls')
    expect(parsed.isMaster).toBe(true)
    expect(parsed.isDrmProtected).toBe(false)
    expect(parsed.videoTracks).toHaveLength(2)
    expect(parsed.videoTracks[0].height).toBe(1080)
    expect(parsed.videoTracks[0].selector).toBe('res=1920x1080:for=best')
    expect(parsed.videoTracks[1].height).toBe(720)

    expect(parsed.audioTracks).toHaveLength(2)
    expect(parsed.audioTracks[0].language).toBe('en')
    expect(parsed.subtitleTracks).toHaveLength(1)

    expect(parsed.normalizedManifestText).toContain(
      'URI="https://cdn.example.com/streams/movie/audio/en/index.m3u8"'
    )
    expect(parsed.normalizedManifestText).toContain(
      'https://cdn.example.com/streams/movie/video/1080p/playlist.m3u8?sig=abc'
    )
    expect(parsed.normalizedManifestText).toContain(
      'https://cdn.example.com/streams/720p/playlist.m3u8'
    )
  })

  it('parses AES-128 encrypted HLS media playlists and resolves blob: base URLs', () => {
    const rawMedia = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key",IV=0x00000000000000000000000000000001
#EXTINF:5.5,
seg-001.ts
#EXTINF:4.5,
seg-002.ts
#EXT-X-ENDLIST
`
    const parsed = parseHlsManifest(rawMedia, 'blob:https://player.site.org/embed/watch.html')
    expect(parsed.isEncryptedAes128).toBe(true)
    expect(parsed.isDrmProtected).toBe(false)
    expect(parsed.isLive).toBe(false)
    expect(parsed.durationSec).toBe(10)
    expect(parsed.segmentCount).toBe(2)
    expect(parsed.normalizedManifestText).toContain(
      'URI="https://player.site.org/embed/keys/enc.key"'
    )
    expect(parsed.normalizedManifestText).toContain('https://player.site.org/embed/seg-001.ts')
  })

  it('detects Widevine DRM in MPEG-DASH MPD manifests and parses tracks/durations', () => {
    expect(parseIso8601Duration('PT1H2M30S')).toBe(3750)

    const mpdXml = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2M0S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v1" width="3840" height="2160" bandwidth="15000000" codecs="hev1.1.6.L150" frameRate="60/1"/>
      <Representation id="v2" width="1920" height="1080" bandwidth="5000000" codecs="avc1.640028" frameRate="30"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="es" mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>
</MPD>`

    const res = detectAndParseManifest(mpdXml, 'https://dash.cdn.test/movies/film/manifest.mpd')
    expect(res).not.toBeNull()
    expect(res!.type).toBe('dash')
    expect(res!.isDrmProtected).toBe(true)
    expect(res!.drmSystem).toBe('Widevine')
    expect(res!.durationSec).toBe(120)
    expect(res!.videoTracks[0].height).toBe(2160)
    expect(res!.audioTracks[0].language).toBe('es')
    expect(res!.normalizedManifestText).toContain(
      '<BaseURL>https://dash.cdn.test/movies/film/</BaseURL>'
    )

    const nonDrmDash = parseDashManifest(
      mpdXml.replace('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed', '00000000-0000-0000-0000-000000000000')
    )
    expect(nonDrmDash.isDrmProtected).toBe(false)
  })
})
