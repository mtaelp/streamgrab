import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { BinaryHealthReport, BinaryStatus } from '@shared/types'
import { resolvePortablePaths } from '../portable/PortablePaths'
import { runtimeFetch } from '../portable/RuntimeFetch'

type BinaryName = BinaryStatus['name']

const BINARY_SPECS: Array<{ name: BinaryName; exe: string; versionArgs: string[] }> = [
  { name: 'ffmpeg', exe: 'ffmpeg.exe', versionArgs: ['-version'] },
  { name: 'ffprobe', exe: 'ffprobe.exe', versionArgs: ['-version'] },
  { name: 'N_m3u8DL-RE', exe: 'N_m3u8DL-RE.exe', versionArgs: ['--version'] },
  { name: 'yt-dlp', exe: 'yt-dlp.exe', versionArgs: ['--version'] }
]

export class BinaryManager {
  public resolveBinaryPath(name: BinaryName): { path: string | null; isPortableLocal: boolean } {
    const paths = resolvePortablePaths()
    const spec = BINARY_SPECS.find((s) => s.name === name)!

    const packagedBinDir =
      typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
        ? path.join(process.resourcesPath, 'bin')
        : null

    // Candidate priority:
    // 1. User-updated persistent binary in <dataRoot>/bin (survives single-file .exe restarts)
    // 2. Portable <portableRoot>/resources/bin (dev mode & unpacked folder builds)
    // 3. Bundled extraResources <process.resourcesPath>/bin (single-file portable .exe builds)
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

    // 5. System PATH fallback
    const whereRes = spawnSync('where.exe', [spec.exe], { encoding: 'utf8' })
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
    const isEphemeralSingleExe =
      Boolean(process.env.PORTABLE_EXECUTABLE_DIR) ||
      (typeof process.resourcesPath === 'string' &&
        process.resourcesPath.length > 0 &&
        paths.binariesDir.toLowerCase().startsWith(process.resourcesPath.toLowerCase()))

    // When running from a single-file portable .exe, save user-triggered binary updates to <dataRoot>/bin
    // so they persist permanently next to the .exe rather than inside %TEMP%.
    let targetDir = isEphemeralSingleExe ? path.join(paths.dataRoot, 'bin') : paths.binariesDir
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

    // 1. FFmpeg & FFprobe
    const ffmpegDest = path.join(targetDir, 'ffmpeg.exe')
    const ffprobeDest = path.join(targetDir, 'ffprobe.exe')
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
      } else {
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
        execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir], { windowsHide: true })
        const f1 = findRecursive(extractDir, 'ffmpeg.exe')
        const f2 = findRecursive(extractDir, 'ffprobe.exe')
        if (f1 && f2) {
          fs.copyFileSync(f1, ffmpegDest)
          fs.copyFileSync(f2, ffprobeDest)
        }
        fs.rmSync(extractDir, { recursive: true, force: true })
        fs.rmSync(zipPath, { force: true })
      }
    }

    // 2. yt-dlp.exe
    const ytdlpDest = path.join(targetDir, 'yt-dlp.exe')
    if (force || !fs.existsSync(ytdlpDest)) {
      await downloadTo(
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        ytdlpDest,
        'yt-dlp.exe'
      )
    }

    // 3. N_m3u8DL-RE.exe
    const nmDest = path.join(targetDir, 'N_m3u8DL-RE.exe')
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
      const asset = (release.assets || []).find(
        (a) => /win-x64.*\.zip$/i.test(a.name) && !/arm/i.test(a.name)
      )
      if (!asset) {
        throw new Error('Could not find win-x64 asset for N_m3u8DL-RE')
      }
      const zipPath = path.join(tmpDir, asset.name)
      const extractDir = path.join(tmpDir, 'nm3u8-extract')
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.mkdirSync(extractDir, { recursive: true })
      await downloadTo(asset.browser_download_url, zipPath, asset.name)
      onProgress?.('Extracting N_m3u8DL-RE...')
      execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir], { windowsHide: true })
      const exe = findRecursive(extractDir, 'N_m3u8DL-RE.exe')
      if (!exe) {
        throw new Error('N_m3u8DL-RE.exe missing inside downloaded archive')
      }
      fs.copyFileSync(exe, nmDest)
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.rmSync(zipPath, { force: true })
    }

    onProgress?.('All portable binaries verified and ready!')
    return this.checkHealth()
  }
}
