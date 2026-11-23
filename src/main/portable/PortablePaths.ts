import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { App } from 'electron'

export interface PortablePathConfig {
  portableRoot: string
  dataRoot: string
  userDataDir: string
  sessionDataDir: string
  tempDir: string
  manifestsCacheDir: string
  segmentsTempDir: string
  logsDir: string
  defaultDownloadsDir: string
  binariesDir: string
}

let cachedConfig: PortablePathConfig | null = null

function canWriteDirectory(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
    fs.accessSync(dirPath, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function defaultSystemAppDataRoot(app?: App): string {
  if (app) {
    return path.join(app.getPath('appData'), 'StreamGrabBrowser')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'StreamGrabBrowser')
  }
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, 'StreamGrabBrowser-Portable')
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdg, 'StreamGrabBrowser')
}

export function resolvePortablePaths(app?: App, customRoot?: string): PortablePathConfig {
  if (cachedConfig && !customRoot) {
    return cachedConfig
  }

  let portableRoot: string
  let isStandardMacApplicationsInstall = false

  if (customRoot) {
    portableRoot = path.resolve(customRoot)
  } else if (process.env.STREAMGRAB_PORTABLE_ROOT) {
    portableRoot = path.resolve(process.env.STREAMGRAB_PORTABLE_ROOT)
  } else if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // Set automatically by electron-builder's single-file Windows 'portable' .exe wrapper
    portableRoot = path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
  } else if (app && app.isPackaged) {
    if (process.platform === 'darwin') {
      // exe is <parent>/StreamGrab Browser.app/Contents/MacOS/StreamGrabBrowser
      const appBundleParent = path.resolve(app.getPath('exe'), '..', '..', '..', '..')
      portableRoot = appBundleParent
      const normalizedParent = appBundleParent.replace(/\/+$/, '')
      const userApps = path.join(os.homedir(), 'Applications')
      if (normalizedParent === '/Applications' || normalizedParent === userApps) {
        isStandardMacApplicationsInstall = true
      }
    } else {
      portableRoot = path.dirname(app.getPath('exe'))
    }
  } else {
    portableRoot = process.cwd()
  }

  // Ensure storageRoot is writable; on macOS /Applications installs or read-only directories (e.g. mounted .dmg or Program Files),
  // fall back cleanly to OS user application support & Downloads directories.
  let storageRoot = portableRoot
  let defaultDownloadsDir = path.join(storageRoot, 'downloads')

  if (
    !customRoot &&
    (isStandardMacApplicationsInstall || !canWriteDirectory(path.join(storageRoot, 'data')))
  ) {
    storageRoot = defaultSystemAppDataRoot(app)
    defaultDownloadsDir = app
      ? path.join(app.getPath('downloads'), 'StreamGrab')
      : path.join(os.homedir(), 'Downloads', 'StreamGrab')
  }

  const dataRoot = path.join(storageRoot, 'data')
  const userDataDir = path.join(dataRoot, 'userData')
  const sessionDataDir = path.join(dataRoot, 'sessionData')
  const tempDir = path.join(dataRoot, 'temp')
  const manifestsCacheDir = path.join(tempDir, 'manifests')
  const segmentsTempDir = path.join(tempDir, 'segments')
  const logsDir = path.join(dataRoot, 'logs')

  const localResourcesBin = path.join(portableRoot, 'resources', 'bin')
  const packagedResourcesBin =
    typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
      ? path.join(process.resourcesPath, 'bin')
      : null

  let binariesDir = localResourcesBin
  const isPackagedApp = Boolean((app && app.isPackaged) || process.env.PORTABLE_EXECUTABLE_DIR)
  if (isPackagedApp) {
    if (packagedResourcesBin && fs.existsSync(packagedResourcesBin)) {
      binariesDir = packagedResourcesBin
    } else if (!fs.existsSync(localResourcesBin)) {
      binariesDir = path.join(dataRoot, 'bin')
    }
  }

  const dirsToEnsure = [
    dataRoot,
    userDataDir,
    sessionDataDir,
    tempDir,
    manifestsCacheDir,
    segmentsTempDir,
    logsDir,
    defaultDownloadsDir
  ]
  if (!packagedResourcesBin || binariesDir !== packagedResourcesBin) {
    dirsToEnsure.push(binariesDir)
  }

  for (const dir of dirsToEnsure) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const cfg: PortablePathConfig = {
    portableRoot,
    dataRoot,
    userDataDir,
    sessionDataDir,
    tempDir,
    manifestsCacheDir,
    segmentsTempDir,
    logsDir,
    defaultDownloadsDir,
    binariesDir
  }

  if (!customRoot) {
    cachedConfig = cfg
  }
  return cfg
}

export function applyPortableElectronPaths(app: App): PortablePathConfig {
  const cfg = resolvePortablePaths(app)
  app.setPath('userData', cfg.userDataDir)
  app.setPath('sessionData', cfg.sessionDataDir)
  app.setPath('temp', cfg.tempDir)
  app.setPath('logs', cfg.logsDir)
  app.setAppLogsPath(cfg.logsDir)
  return cfg
}
