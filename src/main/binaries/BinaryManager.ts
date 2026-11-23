import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { BinaryHealthReport, BinaryStatus } from '@shared/types'
import { resolvePortablePaths } from '../portable/PortablePaths'
import { runtimeFetch } from '../portable/RuntimeFetch'

type BinaryName = BinaryStatus['name']

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

function binFilename(base: string): string {
  return IS_WIN ? `${base}.exe` : base
}

const BINARY_SPECS: Array<{ name: BinaryName; exe: string; versionArgs: string[] }> = [
  { name: 'ffmpeg', exe: binFilename('ffmpeg'), versionArgs: ['-version'] },
  { name: 'ffprobe', exe: binFilename('ffprobe'), versionArgs: ['-version'] },
  { name: 'N_m3u8DL-RE', exe: binFilename('N_m3u8DL-RE'), versionArgs: ['--version'] },
  { name: 'yt-dlp', exe: binFilename('yt-dlp'), versionArgs: ['--version'] }
]

function ensureExecutablePermission(filePath: string): void {
  if (IS_WIN) return
  try {
    fs.chmodSync(filePath, 0o755)
  } catch {
    // ignore permission errors on read-only bundles
  }
  if (IS_MAC) {
    try {
      spawnSync('xattr', ['-cr', filePath], { stdio: 'ignore' })
      spawnSync('codesign', ['--force', '--sign', '-', filePath], { stdio: 'ignore' })
    } catch {
      // ignore if codesign/xattr unavailable
    }
  }
}

export class BinaryManager {
  public resolveBinaryPath(name: BinaryName): { path: string | null; isPortableLocal: boolean } {
    const paths = resolvePortablePaths()
    const spec = BINARY_SPECS.find((s) => s.name === name)!

    const packagedBinDir =
      typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
        ? path.join(process.resourcesPath, 'bin')
        : null

    // Candidate priority:
    // 1. User-updated persistent binary in <dataRoot>/bin
    // 2. Portable <portableRoot>/resources/bin (dev mode & unpacked builds)
    // 3. Bundled extraResources <process.resourcesPath>/bin (packaged .exe / .app builds)
    // 4. Configured binariesDir fallback
    const localCandidates = [
      path.join(paths.dataRoot, 'bin', spec.exe),
      path.join(paths.portableRoot, 'resources', 'bin', spec.exe),
      ...(packagedBinDir ? [path.join(packagedBinDir, spec.exe)] : []),
      path.join(paths.binariesDir, spec.exe)
    ]

    for (const candidate of localCandidates) {
      if (fs.existsSync(candidate)) {
        return { path: candidate, isPortableLocal: true }
      }
    }

    // 5. System PATH / Homebrew fallback
    const lookupCmd = IS_WIN ? 'where.exe' : 'which'
    const lookupEnv = IS_MAC
      ? { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` }
      : process.env

    const whereRes = spawnSync(lookupCmd, [spec.exe], { encoding: 'utf8', env: lookupEnv })
    if (whereRes.status === 0 && whereRes.stdout) {
      const found = whereRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((p) => p && fs.existsSync(p))
      if (found) {
        const insidePortable = found
          .toLowerCase()
          .startsWith(paths.portableRoot.toLowerCase())
        return { path: found, isPortableLocal: insidePortable }
      }
    }

    return { path: null, isPortableLocal: false }
  }

  public getRequiredPath(name: BinaryName): string {
    const resolved = this.resolveBinaryPath(name)
    if (!resolved.path) {
      throw new Error(
        `Missing required binary "${name}". Open Settings -> Portable Binaries or run "pnpm run setup:binaries" to install it.`
      )
    }
    return resolved.path
  }

  public checkHealth(): BinaryHealthReport {
    const paths = resolvePortablePaths()
    const binaries: BinaryStatus[] = BINARY_SPECS.map((spec) => {
      const resolved = this.resolveBinaryPath(spec.name)
      if (!resolved.path) {
        return {
          name: spec.name,
          installed: false,
          path: null,
          version: null,
          isPortableLocal: false
        }
      }

      let version: string | null = null
      try {
        const res = spawnSync(resolved.path, spec.versionArgs, {
          encoding: 'utf8',
          timeout: 6000,
          windowsHide: true
        })
        const firstLine = `${res.stdout || ''}\n${res.stderr || ''}`
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0)
        version = firstLine ? firstLine.slice(0, 80) : 'Installed'
      } catch {
        version = 'Unknown'
      }

      return {
        name: spec.name,
        installed: true,
        path: resolved.path,
        version,
        isPortableLocal: resolved.isPortableLocal
      }
    })

    return {
      portableRoot: paths.portableRoot,
      dataRoot: paths.dataRoot,
      binariesDir: paths.binariesDir,
      binaries
    }
  }

  public async installOrUpdateBinaries(
    onProgress?: (msg: string) => void,
    force = false
  ): Promise<BinaryHealthReport> {
    const paths = resolvePortablePaths()
    const isPackagedBundle =
      Boolean(process.env.PORTABLE_EXECUTABLE_DIR) ||
      (typeof process.resourcesPath === 'string' &&
        process.resourcesPath.length > 0 &&
        paths.binariesDir.toLowerCase().startsWith(process.resourcesPath.toLowerCase()))

    // When running from a packaged .exe or macOS .app bundle, save user-triggered updates to <dataRoot>/bin
    let targetDir = isPackagedBundle ? path.join(paths.dataRoot, 'bin') : paths.binariesDir
    try {
      fs.mkdirSync(targetDir, { recursive: true })
      fs.accessSync(targetDir, fs.constants.W_OK)
    } catch {
      targetDir = path.join(paths.dataRoot, 'bin')
      fs.mkdirSync(targetDir, { recursive: true })
    }

    const tmpDir = path.join(paths.tempDir, 'bin-downloads')
    fs.mkdirSync(tmpDir, { recursive: true })

    const downloadTo = async (url: string, dest: string, label: string): Promise<void> => {
      onProgress?.(`Downloading ${label}...`)
      const res = await runtimeFetch(url, {
        headers: { 'User-Agent': 'StreamGrab-Browser/1.0' },
        redirect: 'follow'
      })
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} while downloading ${label}`)
      }
      const part = `${dest}.tmp`
      const ws = fs.createWriteStream(part)
      await finished(Readable.fromWeb(res.body as never).pipe(ws))
      fs.renameSync(part, dest)
    }

    const findRecursive = (dir: string, exeName: string): string | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const sub = findRecursive(full, exeName)
          if (sub) return sub
        } else if (entry.name.toLowerCase() === exeName.toLowerCase()) {
          return full
        }
      }
      return null
    }

    const tarBin = IS_WIN ? 'tar.exe' : 'tar'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

    // 1. FFmpeg & FFprobe
    const ffmpegExe = binFilename('ffmpeg')
    const ffprobeExe = binFilename('ffprobe')
    const ffmpegDest = path.join(targetDir, ffmpegExe)
    const ffprobeDest = path.join(targetDir, ffprobeExe)

    if (force || !fs.existsSync(ffmpegDest) || !fs.existsSync(ffprobeDest)) {
      const existingFfmpeg = this.resolveBinaryPath('ffmpeg').path
      const existingFfprobe = this.resolveBinaryPath('ffprobe').path
      if (!force && existingFfmpeg && existingFfprobe) {
        onProgress?.('Copying local FFmpeg & FFprobe into portable bin directory...')
        if (path.resolve(existingFfmpeg) !== path.resolve(ffmpegDest)) {
          fs.copyFileSync(existingFfmpeg, ffmpegDest)
        }
        if (path.resolve(existingFfprobe) !== path.resolve(ffprobeDest)) {
          fs.copyFileSync(existingFfprobe, ffprobeDest)
        }
      } else if (IS_MAC) {
        await downloadTo(
          `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-darwin-${arch}`,
          ffmpegDest,
          `FFmpeg macOS (${arch})`
        )
        await downloadTo(
          `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffprobe-darwin-${arch}`,
          ffprobeDest,
          `FFprobe macOS (${arch})`
        )
      } else if (IS_WIN) {
        const zipPath = path.join(tmpDir, 'ffmpeg-win64.zip')
        const extractDir = path.join(tmpDir, 'ffmpeg-extract')
        fs.rmSync(extractDir, { recursive: true, force: true })
        fs.mkdirSync(extractDir, { recursive: true })
        await downloadTo(
          'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
          zipPath,
          'FFmpeg Win64 GPL'
        )
        onProgress?.('Extracting FFmpeg & FFprobe...')
        execFileSync(tarBin, ['-xf', zipPath, '-C', extractDir], { windowsHide: true })
        const f1 = findRecursive(extractDir, ffmpegExe)
        const f2 = findRecursive(extractDir, ffprobeExe)
        if (f1 && f2) {
          fs.copyFileSync(f1, ffmpegDest)
          fs.copyFileSync(f2, ffprobeDest)
        }
        fs.rmSync(extractDir, { recursive: true, force: true })
        fs.rmSync(zipPath, { force: true })
      } else {
        await downloadTo(
          `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-${arch}`,
          ffmpegDest,
          `FFmpeg Linux (${arch})`
        )
        await downloadTo(
          `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffprobe-linux-${arch}`,
          ffprobeDest,
          `FFprobe Linux (${arch})`
        )
      }
      ensureExecutablePermission(ffmpegDest)
      ensureExecutablePermission(ffprobeDest)
    }

    // 2. yt-dlp
    const ytdlpExe = binFilename('yt-dlp')
    const ytdlpDest = path.join(targetDir, ytdlpExe)
    if (force || !fs.existsSync(ytdlpDest)) {
      const ytdlpAsset = IS_WIN ? 'yt-dlp.exe' : IS_MAC ? 'yt-dlp_macos' : 'yt-dlp_linux'
      await downloadTo(
        `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAsset}`,
        ytdlpDest,
        ytdlpAsset
      )
      ensureExecutablePermission(ytdlpDest)
    }

    // 3. N_m3u8DL-RE
    const nmExe = binFilename('N_m3u8DL-RE')
    const nmDest = path.join(targetDir, nmExe)
    if (force || !fs.existsSync(nmDest)) {
      onProgress?.('Checking latest N_m3u8DL-RE release...')
      const apiRes = await runtimeFetch('https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest', {
        headers: {
          'User-Agent': 'StreamGrab-Browser/1.0',
          Accept: 'application/vnd.github+json'
        }
      })
      if (!apiRes.ok) {
        throw new Error(`Failed to fetch N_m3u8DL-RE release info: HTTP ${apiRes.status}`)
      }
      const release = (await apiRes.json()) as {
        assets?: Array<{ name: string; browser_download_url: string }>
      }

      const assetPattern = IS_WIN
        ? new RegExp(`win-${arch}.*\\.zip$`, 'i')
        : IS_MAC
          ? new RegExp(`osx-${arch}.*\\.(tar\\.gz|zip)$`, 'i')
          : new RegExp(`linux-${arch}.*\\.(tar\\.gz|zip)$`, 'i')

      const asset = (release.assets || []).find((a) => assetPattern.test(a.name))
      if (!asset) {
        throw new Error(`Could not find ${process.platform}-${arch} asset for N_m3u8DL-RE`)
      }
      const archivePath = path.join(tmpDir, asset.name)
      const extractDir = path.join(tmpDir, 'nm3u8-extract')
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.mkdirSync(extractDir, { recursive: true })
      await downloadTo(asset.browser_download_url, archivePath, asset.name)
      onProgress?.('Extracting N_m3u8DL-RE...')
      execFileSync(tarBin, ['-xf', archivePath, '-C', extractDir], { windowsHide: true })
      const exe = findRecursive(extractDir, nmExe)
      if (!exe) {
        throw new Error(`${nmExe} missing inside downloaded archive`)
      }
      fs.copyFileSync(exe, nmDest)
      ensureExecutablePermission(nmDest)
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.rmSync(archivePath, { force: true })
    }

    onProgress?.('All portable binaries verified and ready!')
    return this.checkHealth()
  }
}
