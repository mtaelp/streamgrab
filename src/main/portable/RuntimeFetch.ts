/**
 * Uses Electron's Chromium-backed net.fetch (which integrates natively with the
 * Windows OS Root Certificate Store) when running inside Electron Main Process,
 * and falls back cleanly to standard Node global fetch during Vitest / CLI runs.
 */
export async function runtimeFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  if (process.versions.electron) {
    try {
      // Dynamic import/require so standalone Node/Vitest never fails loading 'electron'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron') as typeof import('electron')
      if (electron?.net && typeof electron.net.fetch === 'function') {
        return await electron.net.fetch(String(input), init as Parameters<typeof electron.net.fetch>[1])
      }
    } catch {
      // Fall back to global fetch if called before app.whenReady()
    }
  }
  return await fetch(input, init)
}
