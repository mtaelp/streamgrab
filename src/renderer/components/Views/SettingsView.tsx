import React, { useEffect, useState } from 'react'
import {
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Settings,
  Shield,
  XCircle
} from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'

export const SettingsView: React.FC = () => {
  const settings = useAppStore((s) => s.settings)
  const binaryHealth = useAppStore((s) => s.binaryHealth)
  const binaryProgressMsg = useAppStore((s) => s.binaryProgressMsg)
  const refreshSettings = useAppStore((s) => s.refreshSettings)
  const refreshBinaries = useAppStore((s) => s.refreshBinaries)
  const showToast = useAppStore((s) => s.showToast)

  const [isUpdatingBins, setIsUpdatingBins] = useState(false)
  const [newWhitelistDomain, setNewWhitelistDomain] = useState('')

  useEffect(() => {
    void refreshSettings()
    void refreshBinaries()
  }, [])

  if (!settings) return null

  const update = async (partial: Parameters<typeof window.streamgrab.settings.update>[0]): Promise<void> => {
    await window.streamgrab.settings.update(partial)
    await refreshSettings()
  }

  const handlePickFolder = async (): Promise<void> => {
    const picked = await window.streamgrab.settings.pickFolder()
    if (picked) {
      await update({ downloadDir: picked })
      showToast(`Download folder updated: ${picked}`)
    }
  }

  const handleInstallOrUpdateBins = async (force: boolean): Promise<void> => {
    setIsUpdatingBins(true)
    try {
      await window.streamgrab.binaries.installOrUpdate(force)
      await refreshBinaries()
      showToast('Portable media binaries verified & updated!')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Binary update failed')
    } finally {
      setIsUpdatingBins(false)
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-zinc-950 p-6">
      <div className="mx-auto max-w-4xl space-y-6 pb-10">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-zinc-100">
            <Settings className="h-5 w-5 text-emerald-400" />
            Settings & Portable Environment
          </h1>
          <p className="text-xs text-zinc-400">
            All browser profiles, SQLite databases, caches, and companion tools stay inside your
            portable folder.
          </p>
        </div>

        {/* Portable Paths Overview */}
        {binaryHealth && (
          <section className="rounded-2xl border border-emerald-500/25 bg-zinc-900/70 p-4 space-y-2 text-xs">
            <h2 className="flex items-center gap-2 font-semibold text-emerald-300">
              <HardDrive className="h-4 w-4" /> Active Portable Paths
            </h2>
            <div className="grid grid-cols-1 gap-1.5 text-zinc-300 font-mono text-[11px]">
              <div>
                <span className="text-zinc-500">Portable Root: </span>
                {binaryHealth.portableRoot}
              </div>
              <div>
                <span className="text-zinc-500">Profile & SQLite Data: </span>
                {binaryHealth.dataRoot}
              </div>
              <div>
                <span className="text-zinc-500">Companion Binaries: </span>
                {binaryHealth.binariesDir}
              </div>
            </div>
          </section>
        )}

        {/* Download Engine Settings */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-100">Download & Muxing Engine</h2>

          <div>
            <label className="mb-1.5 block text-xs text-zinc-400">Default Download Folder</label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={settings.downloadDir}
                className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs font-mono text-zinc-200"
              />
              <button
                type="button"
                onClick={() => void handlePickFolder()}
                className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-700"
              >
                <FolderOpen className="h-3.5 w-3.5" /> Browse
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-300">Parallel Connections per Download</span>
                <span className="font-semibold text-emerald-400">
                  {settings.maxThreadsPerDownload} threads
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={64}
                value={settings.maxThreadsPerDownload}
                onChange={(e) => void update({ maxThreadsPerDownload: Number(e.target.value) })}
                className="w-full accent-emerald-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-300">Max Simultaneous Downloads</span>
                <span className="font-semibold text-cyan-400">
                  {settings.maxConcurrentDownloads} tasks
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={8}
                value={settings.maxConcurrentDownloads}
                onChange={(e) => void update({ maxConcurrentDownloads: Number(e.target.value) })}
                className="w-full accent-cyan-500"
              />
            </div>
          </div>

          <div className="space-y-2.5 pt-1 text-xs">
            <label className="flex cursor-pointer items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5">
              <div>
                <p className="font-medium text-zinc-200">
                  Mid-Download 403 Expired Token Auto-Refresh
                </p>
                <p className="text-[11px] text-zinc-500">
                  Silently reloads source page in a muted hidden tab to renew expired CDN links
                  without losing downloaded segments.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.autoRefreshExpiredTokens}
                onChange={(e) => void update({ autoRefreshExpiredTokens: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3.5 py-2.5">
              <div>
                <p className="font-medium text-zinc-200">
                  Accelerate Standard Browser File Downloads
                </p>
                <p className="text-[11px] text-zinc-500">
                  Intercepts regular .zip / .exe / .mp4 / .mkv links and downloads them with
                  multi-threaded HTTP Range splitting.
                </p>
              </div>
              <input
                type="checkbox"
                checked={settings.interceptStandardDownloads}
                onChange={(e) => void update({ interceptStandardDownloads: e.target.checked })}
                className="h-4 w-4 accent-emerald-500"
              />
            </label>
          </div>
        </section>

        {/* Adblock & Whitelist */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Shield className="h-4 w-4 text-sky-400" /> Native Adblock & Anti-Popunder Shield
            </h2>
            <input
              type="checkbox"
              checked={settings.adblockEnabled}
              onChange={(e) => void update({ adblockEnabled: e.target.checked })}
              className="h-4 w-4 accent-sky-500"
            />
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={newWhitelistDomain}
              onChange={(e) => setNewWhitelistDomain(e.target.value)}
              placeholder="Add domain to adblock whitelist (e.g. example.com)"
              className="flex-1 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                if (!newWhitelistDomain.trim()) return
                void window.streamgrab.adblock
                  .toggleDomain(newWhitelistDomain.trim())
                  .then(() => {
                    setNewWhitelistDomain('')
                    void refreshSettings()
                  })
              }}
              className="rounded-xl bg-zinc-800 px-3.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            >
              Add Exception
            </button>
          </div>

          {settings.whitelistedDomains.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {settings.whitelistedDomains.map((dom) => (
                <span
                  key={dom}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-[11px] text-zinc-300"
                >
                  {dom}
                  <button
                    type="button"
                    onClick={() =>
                      void window.streamgrab.adblock.toggleDomain(dom).then(() => refreshSettings())
                    }
                    className="text-zinc-500 hover:text-rose-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Companion Binaries Health & Portable Updater */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Portable Power Trio Binaries
              </h2>
              <p className="text-xs text-zinc-400">
                Bundled inside resources/bin so StreamGrab runs standalone on Windows &amp; macOS.
              </p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={isUpdatingBins}
                onClick={() => void handleInstallOrUpdateBins(false)}
                className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {isUpdatingBins ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Verify / Repair Missing
              </button>
              <button
                type="button"
                disabled={isUpdatingBins}
                onClick={() => void handleInstallOrUpdateBins(true)}
                className="rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
              >
                Force Update All
              </button>
            </div>
          </div>

          {binaryProgressMsg && isUpdatingBins && (
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
              {binaryProgressMsg}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {binaryHealth?.binaries.map((bin) => (
              <div
                key={bin.name}
                className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-100">
                    {bin.path ? bin.path.split(/[\\/]/).pop() : bin.name}
                  </span>
                  {bin.installed ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {bin.isPortableLocal ? 'Portable Local' : 'System PATH'}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-400">
                      <XCircle className="h-3.5 w-3.5" /> Missing
                    </span>
                  )}
                </div>
                <p className="truncate text-[11px] text-zinc-400" title={bin.version || ''}>
                  {bin.version || 'Not installed'}
                </p>
                <p className="truncate font-mono text-[10px] text-zinc-500" title={bin.path || ''}>
                  {bin.path || '—'}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
