import type { WebContents } from 'electron'
import type { AdblockService } from '../adblock/AdblockService'
import { diagLogger } from '../logger/DiagnosticLogger'

export interface PopupGuardOptions {
  isHeadless?: boolean
  isIncognito?: boolean
  adblock: AdblockService
  onPopupBlocked?: (blockedUrl: string, isIncognito: boolean) => void
  onOpenManagedTab?: (url: string, isIncognito: boolean) => void
}

const KNOWN_AUTH_POPUP_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'github.com',
  'discord.com'
]

const AD_REDIRECT_URL_PATTERNS =
  /([?&](aff|aff_id|clickid|subid|utm_campaign|zoneid|ban|adid|popunder)=)|(\/(go|out|redirect|aff|promo|bet|pop|click)\/)|(bet|casino|slot|bahis|bonus|spin|jackpot)/i

function getRegistrableRoot(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
    const parts = host.split('.')
    if (parts.length <= 2) return host
    return parts.slice(-2).join('.')
  } catch {
    return null
  }
}

/**
 * Strict Anti-Popup & Clickjacking Blocker:
 * Streaming sites and embedded iframe players frequently trigger window.open() or synthetic
 * <a target="_blank"> clicks to rotating 0-day betting/ad domains on the first click over the video.
 *
 * Policy:
 * 1. Block all empty/script/adblock-matched URLs and known affiliate/betting redirect patterns.
 * 2. Block ALL cross-domain popups by default when Adblock is active on the current site
 *    (except OAuth sign-in dialogs), surfacing a non-intrusive "Blocked popup" notification
 *    so the user can still open it manually if they ever genuinely wanted it.
 * 3. Allow same-domain middle-clicks / new-tab links cleanly inside our Tab Strip.
 */
export function attachPopupGuard(webContents: WebContents, opts: PopupGuardOptions): void {
  webContents.setWindowOpenHandler((details) => {
    const targetUrl = (details.url || '').trim()
    const mainPageUrl = webContents.getURL() || ''
    const sourceUrl = details.referrer?.url || mainPageUrl

    const recordDecision = (decision: string, reason: string): void => {
      diagLogger.log(
        'POPUP',
        'setWindowOpenHandler',
        {
          decision,
          reason,
          targetUrl,
          disposition: details.disposition,
          frameName: details.frameName,
          sourceUrl,
          mainPageUrl
        },
        { url: mainPageUrl }
      )
    }

    // 1. Headless sniffer views never open child windows
    if (opts.isHeadless) {
      recordDecision('deny', 'headless_view')
      return { action: 'deny' }
    }

    // 2. Drop empty about:blank / javascript: pop-unders immediately
    if (
      !targetUrl ||
      targetUrl === 'about:blank' ||
      targetUrl.startsWith('about:') ||
      targetUrl.startsWith('javascript:')
    ) {
      recordDecision('deny', 'empty_or_script_url')
      opts.onPopupBlocked?.(targetUrl || 'about:blank', Boolean(opts.isIncognito))
      return { action: 'deny' }
    }

    let parsedTarget: URL
    try {
      parsedTarget = new URL(targetUrl)
    } catch {
      recordDecision('deny', 'malformed_url')
      return { action: 'deny' }
    }

    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      recordDecision('deny', 'non_http_protocol')
      return { action: 'deny' }
    }

    const isSiteWhitelisted = opts.adblock.isDomainWhitelisted(mainPageUrl)

    // 3. Always allow genuine OAuth login popups
    const targetHost = parsedTarget.hostname.toLowerCase()
    if (KNOWN_AUTH_POPUP_HOSTS.some((h) => targetHost === h || targetHost.endsWith(`.${h}`))) {
      recordDecision('allow_window', 'known_oauth_host')
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true
        }
      }
    }

    // 4. Strict Unsolicited Popup Blocker:
    //    Streaming sites bypass cross-origin checks by opening SAME-DOMAIN redirector URLs
    //    (e.g. https://stream-portal.example/go/promo or /redirect) via window.open / <a target="_blank">,
    //    which then 302-redirect to external ad/betting networks!
    //    When Adblock Shield is active on this site, deny ALL unsolicited window.open / target="_blank"
    //    popups and surface a non-intrusive "[Open Tab]" button in the toast if the user wants it.
    if (!isSiteWhitelisted) {
      recordDecision('deny', 'strict_popup_shield')
      opts.onPopupBlocked?.(targetUrl, Boolean(opts.isIncognito))
      return { action: 'deny' }
    }

    // 5. Only when user explicitly whitelisted this domain: allow new-tab navigation
    recordDecision('open_managed_tab', 'whitelisted_domain_link')
    opts.onOpenManagedTab?.(targetUrl, Boolean(opts.isIncognito))
    return { action: 'deny' }
  })
}
