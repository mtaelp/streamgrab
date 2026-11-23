import type { App } from 'electron'

export function computeCleanChromeUserAgent(): string {
  const chromeVer = process.versions.chrome || '136.0.0.0'
  const major = chromeVer.split('.')[0] || '136'
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  }
  if (process.platform === 'linux') {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export function getChromeMajorVersion(): string {
  const chromeVer = process.versions.chrome || '136.0.0.0'
  return chromeVer.split('.')[0] || '136'
}

export function applyGlobalStealthFlags(app: App): void {
  const cleanUa = computeCleanChromeUserAgent()
  app.userAgentFallback = cleanUa
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')
}

export function normalizeClientHintHeaders(
  requestHeaders: Record<string, string>
): Record<string, string> {
  const major = getChromeMajorVersion()
  const fullVer = process.versions.chrome || `${major}.0.0.0`
  const out = { ...requestHeaders }

  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase()
    if (lower === 'user-agent' && out[key]?.includes('Electron')) {
      out[key] = computeCleanChromeUserAgent()
    } else if (lower === 'sec-ch-ua') {
      out[key] = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`
    } else if (lower === 'sec-ch-ua-full-version-list') {
      out[key] = `"Chromium";v="${fullVer}", "Google Chrome";v="${fullVer}", "Not-A.Brand";v="99.0.0.0"`
    }
  }

  return out
}
