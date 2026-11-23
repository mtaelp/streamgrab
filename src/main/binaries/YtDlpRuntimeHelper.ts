import fs from 'node:fs'
import path from 'node:path'
import { resolvePortablePaths } from '../portable/PortablePaths'

let cachedNodeWrapperPath: string | null = null
let cachedNeedsNoCheckCert = false

export function isTlsCertVerifyError(stderrText: string): boolean {
  return /CERTIFICATE_VERIFY_FAILED|unable to get local issuer certificate|self[- ]signed certificate in certificate chain/i.test(
    stderrText
  )
}

export function getCachedNoCheckCertificates(): boolean {
  return cachedNeedsNoCheckCert
}

export function markNeedsNoCheckCertificates(): void {
  cachedNeedsNoCheckCert = true
}

/**
 * Provides yt-dlp with a guaranteed JavaScript runtime (`--js-runtimes node:<path>`)
 * for YouTube's EJS / n-challenge solver — even on clean end-user Windows/macOS machines
 * without Node.js or Deno installed — by wrapping StreamGrab's own Electron binary
 * with `ELECTRON_RUN_AS_NODE=1`.
 */
export function resolveYtDlpNodeRuntimeArg(): string | null {
  try {
    if (cachedNodeWrapperPath && fs.existsSync(cachedNodeWrapperPath)) {
      return `node:${cachedNodeWrapperPath}`
    }

    const execBase = path.basename(process.execPath).toLowerCase()
    const isPlainNode = execBase === 'node' || execBase === 'node.exe'
    if (isPlainNode && !process.versions.electron) {
      cachedNodeWrapperPath = process.execPath
      return `node:${cachedNodeWrapperPath}`
    }

    const paths = resolvePortablePaths()
    const runtimeDir = path.join(paths.tempDir, 'js-runtime')
    fs.mkdirSync(runtimeDir, { recursive: true })

    if (process.platform === 'win32') {
      const cmdPath = path.join(runtimeDir, 'streamgrab-node.cmd')
      const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`
      fs.writeFileSync(cmdPath, content, 'ascii')
      cachedNodeWrapperPath = cmdPath
    } else {
      const shPath = path.join(runtimeDir, 'streamgrab-node.sh')
      const escapedExec = process.execPath.replace(/"/g, '\\"')
      const content = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${escapedExec}" "$@"\n`
      fs.writeFileSync(shPath, content, { encoding: 'utf8', mode: 0o755 })
      fs.chmodSync(shPath, 0o755)
      cachedNodeWrapperPath = shPath
    }

    return `node:${cachedNodeWrapperPath}`
  } catch {
    return null
  }
}
