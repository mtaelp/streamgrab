import type {
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnHeadersReceivedListenerDetails,
  Session
} from 'electron'
import { normalizeClientHintHeaders } from '../browser/StealthNormalizer'

export interface BypassPolicy {
  isAdblockEnabled: () => boolean
  isUrlOrTabWhitelisted: (details: {
    url: string
    referrer?: string
    webContentsId?: number
  }) => boolean
}

export function extractHostname(rawUrl?: string): string | null {
  if (!rawUrl) return null
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

export function isDomainInWhitelist(hostname: string | null, whitelist: string[]): boolean {
  if (!hostname || whitelist.length === 0) return false
  const clean = hostname.toLowerCase().replace(/^www\./, '')
  return whitelist.some((entry) => {
    const w = entry.toLowerCase().trim().replace(/^www\./, '')
    return w.length > 0 && (clean === w || clean.endsWith(`.${w}`))
  })
}

/**
 * Wraps an Electron Session's webRequest object so that:
 * 1. @ghostery/adblocker-electron's onBeforeRequest & onHeadersReceived hooks can be
 *    dynamically bypassed per-domain or globally without detaching/re-attaching listeners.
 * 2. Stealth Client-Hint header normalization runs cleanly on onBeforeSendHeaders
 *    without clashing with any adblocker hooks.
 */
export function createAdblockSessionProxy(session: Session, policy: BypassPolicy): Session {
  // Always install stealth outbound header normalizer on the real session
  session.webRequest.onBeforeSendHeaders((details: OnBeforeSendHeadersListenerDetails, callback) => {
    const requestHeaders = normalizeClientHintHeaders(details.requestHeaders)
    callback({ cancel: false, requestHeaders })
  })

  const webRequestProxy = new Proxy(session.webRequest, {
    get(target, prop, receiver) {
      if (prop === 'onBeforeRequest') {
        return (
          filterOrListener: unknown,
          maybeListener?: (
            details: OnBeforeRequestListenerDetails,
            callback: (resp: Electron.CallbackResponse) => void
          ) => void
        ) => {
          const hasFilter = typeof filterOrListener === 'object' && filterOrListener !== null
          const listener = (hasFilter ? maybeListener : filterOrListener) as
            | ((
                details: OnBeforeRequestListenerDetails,
                callback: (resp: Electron.CallbackResponse) => void
              ) => void)
            | null

          if (!listener) {
            target.onBeforeRequest(null)
            return
          }

          const wrapped = (
            details: OnBeforeRequestListenerDetails,
            callback: (resp: Electron.CallbackResponse) => void
          ): void => {
            if (
              !policy.isAdblockEnabled() ||
              policy.isUrlOrTabWhitelisted({
                url: details.url,
                referrer: details.referrer,
                webContentsId: details.webContentsId
              })
            ) {
              callback({ cancel: false })
              return
            }
            listener(details, callback)
          }

          if (hasFilter) {
            target.onBeforeRequest(filterOrListener as Electron.WebRequestFilter, wrapped)
          } else {
            target.onBeforeRequest(wrapped)
          }
        }
      }

      if (prop === 'onHeadersReceived') {
        return (
          filterOrListener: unknown,
          maybeListener?: (
            details: OnHeadersReceivedListenerDetails,
            callback: (resp: Electron.HeadersReceivedResponse) => void
          ) => void
        ) => {
          const hasFilter = typeof filterOrListener === 'object' && filterOrListener !== null
          const listener = (hasFilter ? maybeListener : filterOrListener) as
            | ((
                details: OnHeadersReceivedListenerDetails,
                callback: (resp: Electron.HeadersReceivedResponse) => void
              ) => void)
            | null

          if (!listener) {
            target.onHeadersReceived(null)
            return
          }

          const wrapped = (
            details: OnHeadersReceivedListenerDetails,
            callback: (resp: Electron.HeadersReceivedResponse) => void
          ): void => {
            if (
              !policy.isAdblockEnabled() ||
              policy.isUrlOrTabWhitelisted({
                url: details.url,
                referrer: details.referrer,
                webContentsId: details.webContentsId
              })
            ) {
              callback({ cancel: false })
              return
            }
            listener(details, callback)
          }

          if (hasFilter) {
            target.onHeadersReceived(filterOrListener as Electron.WebRequestFilter, wrapped)
          } else {
            target.onHeadersReceived(wrapped)
          }
        }
      }

      const val = Reflect.get(target, prop, receiver)
      return typeof val === 'function' ? val.bind(target) : val
    }
  })

  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === 'webRequest') {
        return webRequestProxy
      }
      const val = Reflect.get(target, prop, receiver)
      return typeof val === 'function' ? val.bind(target) : val
    }
  })
}
