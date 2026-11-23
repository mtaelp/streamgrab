import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const BIN_DIR = path.join(PROJECT_ROOT, 'resources', 'bin')
const PORTABLE_ENV_DIR = path.join(PROJECT_ROOT, '.portable-env', 'downloads-tmp')
const DATA_DIR = path.join(PROJECT_ROOT, 'data')
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'downloads')

function readFlagValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(`${prefix}=`))
  return hit ? hit.slice(prefix.length + 1) : null
}

const forceUpdate = process.argv.includes('--force')
const isCi = Boolean(process.env.CI) || process.argv.includes('--ci')
const skipVerify = process.argv.includes('--skip-verify')
const targetPlatform = readFlagValue('--platform') || process.platform
const targetArch = readFlagValue('--arch') || (process.arch === 'arm64' ? 'arm64' : 'x64')

const IS_WIN = targetPlatform === 'win32'
const IS_MAC = targetPlatform === 'darwin'
const binExt = IS_WIN ? '.exe' : ''
const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar'

for (const dir of isCi ? [BIN_DIR, PORTABLE_ENV_DIR] : [BIN_DIR, PORTABLE_ENV_DIR, DATA_DIR, DOWNLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

function makeExecutable(filePath) {
  if (IS_WIN || process.platform === 'win32') return
  try {
    fs.chmodSync(filePath, 0o755)
  } catch {
    // ignore
  }
  if (process.platform === 'darwin') {
    spawnSync('xattr', ['-cr', filePath], { stdio: 'ignore' })
    spawnSync('codesign', ['--force', '--sign', '-', filePath], { stdio: 'ignore' })
  }
}

async function downloadFile(url, destPath, label) {
  console.log(`[setup:binaries] Downloading ${label} from ${url} ...`)
  const res = await fetch(url, {
    headers: { 'User-Agent': 'StreamGrab-Binary-Bootstrapper/1.0' },
    redirect: 'follow'
  })
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${label}: HTTP ${res.status} ${res.statusText}`)
  }
  const tmpPath = `${destPath}.tmp`
  const fileStream = fs.createWriteStream(tmpPath)
  await finished(Readable.fromWeb(res.body).pipe(fileStream))
  fs.renameSync(tmpPath, destPath)
  makeExecutable(destPath)
  console.log(`[setup:binaries] Saved ${label} -> ${destPath}`)
}

function findOnSystemPath(exeName) {
  if (targetPlatform !== process.platform || targetArch !== process.arch) return null
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
  const res = spawnSync(cmd, [exeName], { encoding: 'utf8' })
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && fs.existsSync(first)) return first
  }
  if (process.platform === 'win32') {
    const fallback = path.join('C:\\ffmpeg\\bin', exeName)
    if (fs.existsSync(fallback)) return fallback
  }
  return null
}

function findFileRecursive(dir, targetName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, targetName)
      if (found) return found
    } else if (entry.name.toLowerCase() === targetName.toLowerCase()) {
      return full
    }
  }
  return null
}

async function ensureFfmpegAndFfprobe() {
  const ffmpegName = `ffmpeg${binExt}`
  const ffprobeName = `ffprobe${binExt}`
  const ffmpegDest = path.join(BIN_DIR, ffmpegName)
  const ffprobeDest = path.join(BIN_DIR, ffprobeName)

  if (!forceUpdate && fs.existsSync(ffmpegDest) && fs.existsSync(ffprobeDest)) {
    console.log(`[setup:binaries] Portable ${ffmpegName} & ${ffprobeName} already present in resources/bin.`)
    return
  }

  const sysFfmpeg = findOnSystemPath(ffmpegName)
  const sysFfprobe = findOnSystemPath(ffprobeName)
  if (sysFfmpeg && sysFfprobe && !forceUpdate && !isCi) {
    console.log(`[setup:binaries] Copying local ${sysFfmpeg} & ${sysFfprobe} into portable resources/bin...`)
    fs.copyFileSync(sysFfmpeg, ffmpegDest)
    fs.copyFileSync(sysFfprobe, ffprobeDest)
    makeExecutable(ffmpegDest)
    makeExecutable(ffprobeDest)
    return
  }

  if (IS_MAC) {
    await downloadFile(
      `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-darwin-${targetArch}`,
      ffmpegDest,
      `FFmpeg macOS (${targetArch})`
    )
    await downloadFile(
      `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffprobe-darwin-${targetArch}`,
      ffprobeDest,
      `FFprobe macOS (${targetArch})`
    )
    return
  }

  if (IS_WIN) {
    const zipUrl =
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
    const zipPath = path.join(PORTABLE_ENV_DIR, 'ffmpeg-win64.zip')
    const extractDir = path.join(PORTABLE_ENV_DIR, 'ffmpeg-extract')
    fs.rmSync(extractDir, { recursive: true, force: true })
    fs.mkdirSync(extractDir, { recursive: true })

    await downloadFile(zipUrl, zipPath, 'FFmpeg Win64 GPL')
    execFileSync(tarCmd, ['-xf', zipPath, '-C', extractDir])

    const foundFfmpeg = findFileRecursive(extractDir, ffmpegName)
    const foundFfprobe = findFileRecursive(extractDir, ffprobeName)
    if (!foundFfmpeg || !foundFfprobe) {
      throw new Error('Could not locate ffmpeg.exe / ffprobe.exe inside downloaded archive')
    }
    fs.copyFileSync(foundFfmpeg, ffmpegDest)
    fs.copyFileSync(foundFfprobe, ffprobeDest)
    fs.rmSync(extractDir, { recursive: true, force: true })
    fs.rmSync(zipPath, { force: true })
    return
  }

  await downloadFile(
    `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-${targetArch}`,
    ffmpegDest,
    `FFmpeg Linux (${targetArch})`
  )
  await downloadFile(
    `https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffprobe-linux-${targetArch}`,
    ffprobeDest,
    `FFprobe Linux (${targetArch})`
  )
}

async function ensureYtDlp() {
  const exeName = `yt-dlp${binExt}`
  const dest = path.join(BIN_DIR, exeName)
  if (!forceUpdate && fs.existsSync(dest)) {
    console.log(`[setup:binaries] Portable ${exeName} already present in resources/bin.`)
    return
  }
  const releaseAsset = IS_WIN ? 'yt-dlp.exe' : IS_MAC ? 'yt-dlp_macos' : 'yt-dlp_linux'
  await downloadFile(
    `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${releaseAsset}`,
    dest,
    releaseAsset
  )
}

async function ensureNm3u8DlRe() {
  const exeName = `N_m3u8DL-RE${binExt}`
  const dest = path.join(BIN_DIR, exeName)
  if (!forceUpdate && fs.existsSync(dest)) {
    console.log(`[setup:binaries] Portable ${exeName} already present in resources/bin.`)
    return
  }

  console.log('[setup:binaries] Querying latest N_m3u8DL-RE release from GitHub API...')
  const headers = {
    'User-Agent': 'StreamGrab-Binary-Bootstrapper/1.0',
    Accept: 'application/vnd.github+json'
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  const apiRes = await fetch('https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest', {
    headers
  })
  if (!apiRes.ok) {
    throw new Error(`GitHub API error for N_m3u8DL-RE: HTTP ${apiRes.status}`)
  }
  const release = await apiRes.json()

  const assetRegex = IS_WIN
    ? new RegExp(`win-${targetArch}.*\\.zip$`, 'i')
    : IS_MAC
      ? new RegExp(`osx-${targetArch}.*\\.(tar\\.gz|zip)$`, 'i')
      : new RegExp(`linux-${targetArch}.*\\.(tar\\.gz|zip)$`, 'i')

  const asset = (release.assets || []).find((a) => assetRegex.test(a.name))
  if (!asset) {
    throw new Error(`No ${targetPlatform}-${targetArch} asset found in latest N_m3u8DL-RE release`)
  }

  const archivePath = path.join(PORTABLE_ENV_DIR, asset.name)
  const extractDir = path.join(PORTABLE_ENV_DIR, 'nm3u8-extract')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })

  await downloadFile(asset.browser_download_url, archivePath, asset.name)
  execFileSync(tarCmd, ['-xf', archivePath, '-C', extractDir])

  const foundExe = findFileRecursive(extractDir, exeName)
  if (!foundExe) {
    throw new Error(`${exeName} not found inside extracted release archive`)
  }
  fs.copyFileSync(foundExe, dest)
  makeExecutable(dest)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.rmSync(archivePath, { force: true })
}

function verifyBinary(baseName, args) {
  const exeName = `${baseName}${binExt}`
  const fullPath = path.join(BIN_DIR, exeName)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing portable binary: ${fullPath}`)
  }
  if (skipVerify || targetPlatform !== process.platform || targetArch !== process.arch) {
    const stat = fs.statSync(fullPath)
    console.log(`[setup:binaries] Staged ${exeName} (${(stat.size / 1024 / 1024).toFixed(1)} MB) for ${targetPlatform}-${targetArch}`)
    return
  }
  const res = spawnSync(fullPath, args, { encoding: 'utf8', timeout: 10000 })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.split(/\r?\n/).find((l) => l.trim().length > 0) || 'OK'
  console.log(`[setup:binaries] Verified ${exeName}: ${out.trim().slice(0, 90)}`)
}

async function main() {
  console.log(`[setup:binaries] Target=${targetPlatform}-${targetArch} | BinDir=${BIN_DIR}`)
  await ensureFfmpegAndFfprobe()
  await ensureYtDlp()
  await ensureNm3u8DlRe()

  verifyBinary('ffmpeg', ['-version'])
  verifyBinary('ffprobe', ['-version'])
  verifyBinary('yt-dlp', ['--version'])
  verifyBinary('N_m3u8DL-RE', ['--version'])
  console.log(`[setup:binaries] All 4 media binaries are ready in ${BIN_DIR}!`)
}

main().catch((err) => {
  console.error('[setup:binaries] ERROR:', err)
  process.exit(1)
})
