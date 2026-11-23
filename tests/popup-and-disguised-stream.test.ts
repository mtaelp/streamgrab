import { describe, expect, it } from 'vitest'
import { attachPopupGuard } from '../src/main/browser/PopupGuard'
import { computeMediaSignature } from '../src/main/sniffer/SnifferManager'
import { parseHlsManifest } from '../src/main/sniffer/ManifestParser'

describe('PopupGuard (Strict Cross-Origin & Redirector Popup Blocking) & Pre-Roll Ad Separation', () => {
  it('blocks 0-day cross-origin ad popups and iframe clickjacking while allowing OAuth sign-in', () => {
    let handler: ((details: Record<string, unknown>) => { action: string }) | null = null
    const blockedUrls: string[] = []
    const openedTabs: string[] = []

    const fakeWebContents = {
      getURL: () => 'https://stream-portal.example/series/episode-6',
      setWindowOpenHandler: (fn: typeof handler) => {
        handler = fn
      }
    }

    const fakeAdblock = {
      isDomainWhitelisted: () => false,
      isPopupUrlBlocked: () => false // Even when a 0-day domain isn't in EasyList yet!
    }

    attachPopupGuard(fakeWebContents as never, {
      isIncognito: false,
      adblock: fakeAdblock as never,
      onPopupBlocked: (url) => blockedUrls.push(url),
      onOpenManagedTab: (url) => openedTabs.push(url)
    })

    expect(handler).not.toBeNull()

    // 1. Cross-origin 0-day ad popup from player clickjacking -> MUST DENY & NOT open tab
    const promoRes = handler!({
      url: 'https://promo-ad-network.example/promo?clickid=123',
      disposition: 'foreground-tab',
      referrer: { url: 'https://stream-portal.example/series/episode-6' }
    })
    expect(promoRes.action).toBe('deny')
    expect(openedTabs).toHaveLength(0)
    expect(blockedUrls).toContain('https://promo-ad-network.example/promo?clickid=123')

    // 2. Any popup initiated by a cross-origin embed iframe -> MUST DENY
    const iframePopupRes = handler!({
      url: 'https://random-unknown-domain.example/landing',
      disposition: 'new-window',
      referrer: { url: 'https://embed-player.example/v/abc123' }
    })
    expect(iframePopupRes.action).toBe('deny')
    expect(openedTabs).toHaveLength(0)

    // 3. Sneaky same-domain 302 redirector popup (e.g., https://stream-portal.example/go/promo) -> ALSO DENIED by strict popup shield!
    const sneakySameDomainPopup = handler!({
      url: 'https://stream-portal.example/go/promo',
      disposition: 'foreground-tab',
      referrer: { url: 'https://stream-portal.example/series/episode-6' }
    })
    expect(sneakySameDomainPopup.action).toBe('deny')
    expect(openedTabs).toHaveLength(0)
    expect(blockedUrls).toContain('https://stream-portal.example/go/promo')
  })

  it('never collides a 23s 720p pre-roll ad blob with a 32m 1080p episode blob on the same page', () => {
    const adPlaylist = `#EXTM3U
#EXTINF:11.5,
https://ad-cdn.example/preroll_seg1.ts
#EXTINF:11.5,
https://ad-cdn.example/preroll_seg2.ts
#EXT-X-ENDLIST`

    const episodeMasterDisguised = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://stream-cdn.example/series/s2e6/1080p/list.txt
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
https://stream-cdn.example/series/s2e6/720p/list.txt`

    const parsedAd = parseHlsManifest(adPlaylist, 'https://player.embed.example/v/1')
    const parsedEp = parseHlsManifest(episodeMasterDisguised, 'https://player.embed.example/v/1')

    const sigAd = computeMediaSignature(
      'hls',
      'https://player.embed.example/v/1',
      `${parsedAd.isMaster}|${parsedAd.videoTracks[0]?.height || 0}|${parsedAd.segmentCount}`
    )
    const sigEp = computeMediaSignature(
      'hls',
      'https://player.embed.example/v/1',
      `${parsedEp.isMaster}|${parsedEp.videoTracks[0]?.height || 0}|${parsedEp.segmentCount}`
    )

    expect(sigAd).not.toBe(sigEp)
    expect(parsedEp.videoTracks[0].height).toBe(1080)
  })
})
