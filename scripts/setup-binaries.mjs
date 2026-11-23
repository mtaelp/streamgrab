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

const forceUpdate = process.argv.includes('--force')
const isCi = Boolean(process.env.CI) || process.argv.includes('--ci')

for (const dir of isCi ? [BIN_DIR, PORTABLE_ENV_DIR] : [BIN_DIR, PORTABLE_ENV_DIR, DATA_DIR, DOWNLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
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
  console.log(`[setup:binaries] Saved ${label} -> ${destPath}`)
}

function findOnSystemPath(exeName) {
  const res = spawnSync('where.exe', [exeName], { encoding: 'utf8' })
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first && fs.existsSync(first)) return first
  }
  const fallback = path.join('C:\\ffmpeg\\bin', exeName)
  if (fs.existsSync(fallback)) return fallback
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
  const ffmpegDest = path.join(BIN_DIR, 'ffmpeg.exe')
  const ffprobeDest = path.join(BIN_DIR, 'ffprobe.exe')

  if (!forceUpdate && fs.existsSync(ffmpegDest) && fs.existsSync(ffprobeDest)) {
    console.log('[setup:binaries] Portable ffmpeg.exe & ffprobe.exe already present in resources/bin.')
    return
  }

  const sysFfmpeg = findOnSystemPath('ffmpeg.exe')
  const sysFfprobe = findOnSystemPath('ffprobe.exe')
  if (sysFfmpeg && sysFfprobe && !forceUpdate && !isCi) {
    console.log(`[setup:binaries] Copying local ${sysFfmpeg} & ${sysFfprobe} into portable resources/bin...`)
    fs.copyFileSync(sysFfmpeg, ffmpegDest)
    fs.copyFileSync(sysFfprobe, ffprobeDest)
    return
  }

  const zipUrl =
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  const zipPath = path.join(PORTABLE_ENV_DIR, 'ffmpeg-win64.zip')
  const extractDir = path.join(PORTABLE_ENV_DIR, 'ffmpeg-extract')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })

  await downloadFile(zipUrl, zipPath, 'FFmpeg Win64 GPL')
  execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir])

  const foundFfmpeg = findFileRecursive(extractDir, 'ffmpeg.exe')
  const foundFfprobe = findFileRecursive(extractDir, 'ffprobe.exe')
  if (!foundFfmpeg || !foundFfprobe) {
    throw new Error('Could not locate ffmpeg.exe / ffprobe.exe inside downloaded archive')
  }
  fs.copyFileSync(foundFfmpeg, ffmpegDest)
  fs.copyFileSync(foundFfprobe, ffprobeDest)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.rmSync(zipPath, { force: true })
}

async function ensureYtDlp() {
  const dest = path.join(BIN_DIR, 'yt-dlp.exe')
  if (!forceUpdate && fs.existsSync(dest)) {
    console.log('[setup:binaries] Portable yt-dlp.exe already present in resources/bin.')
    return
  }
  await downloadFile(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    dest,
    'yt-dlp.exe'
  )
}

async function ensureNm3u8DlRe() {
  const dest = path.join(BIN_DIR, 'N_m3u8DL-RE.exe')
  if (!forceUpdate && fs.existsSync(dest)) {
    console.log('[setup:binaries] Portable N_m3u8DL-RE.exe already present in resources/bin.')
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
  const asset = (release.assets || []).find((a) =>
    /win-x64.*\.zip$/i.test(a.name) && !/arm/i.test(a.name)
  )
  if (!asset) {
    throw new Error('No win-x64 zip asset found in latest N_m3u8DL-RE release')
  }

  const zipPath = path.join(PORTABLE_ENV_DIR, asset.name)
  const extractDir = path.join(PORTABLE_ENV_DIR, 'nm3u8-extract')
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.mkdirSync(extractDir, { recursive: true })

  await downloadFile(asset.browser_download_url, zipPath, asset.name)
  execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir])

  const foundExe = findFileRecursive(extractDir, 'N_m3u8DL-RE.exe')
  if (!foundExe) {
    throw new Error('N_m3u8DL-RE.exe not found inside extracted release zip')
  }
  fs.copyFileSync(foundExe, dest)
  fs.rmSync(extractDir, { recursive: true, force: true })
  fs.rmSync(zipPath, { force: true })
}

function verifyBinary(exeName, args) {
  const fullPath = path.join(BIN_DIR, exeName)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing portable binary: ${fullPath}`)
  }
  const res = spawnSync(fullPath, args, { encoding: 'utf8', timeout: 10000 })
  const out = `${res.stdout || ''}\n${res.stderr || ''}`.split(/\r?\n/).find((l) => l.trim().length > 0) || 'OK'
  console.log(`[setup:binaries] Verified ${exeName}: ${out.trim().slice(0, 90)}`)
}

async function main() {
  console.log(`[setup:binaries] Portable bin directory: ${BIN_DIR}`)
  await ensureFfmpegAndFfprobe()
  await ensureYtDlp()
  await ensureNm3u8DlRe()

  verifyBinary('ffmpeg.exe', ['-version'])
  verifyBinary('ffprobe.exe', ['-version'])
  verifyBinary('yt-dlp.exe', ['--version'])
  verifyBinary('N_m3u8DL-RE.exe', ['--version'])
  console.log(`[setup:binaries] All 4 portable media binaries are ready in ${BIN_DIR}!`)
}

main().catch((err) => {
  console.error('[setup:binaries] ERROR:', err)
  process.exit(1)
})
