import crypto from 'node:crypto'
import { WebContentsView } from 'electron'
import type { DetectedMedia, HeadlessProbeJob } from '@shared/types'
import type { AdblockService } from '../adblock/AdblockService'
import { attachPopupGuard } from '../browser/PopupGuard'
import { PERSIST_PARTITION, type SessionManager } from '../browser/SessionManager'
import type { SnifferManager } from './SnifferManager'
import type { YtDlpInspector } from './YtDlpInspector'

interface ActiveProbe {
  job: HeadlessProbeJob
  view: WebContentsView | null
  probeTabId: string
  unsubscribe: (() => void) | null
  timeoutTimer: NodeJS.Timeout | null
  settleTimer: NodeJS.Timeout | null
}

export class HeadlessSniffer {
  private sessionManager: SessionManager
  private adblock: AdblockService
  private sniffer: SnifferManager
  private ytdlp: YtDlpInspector
  private onJobsUpdated?: (jobs: HeadlessProbeJob[]) => void

  private probes = new Map<string, ActiveProbe>()
  private jobHistory: HeadlessProbeJob[] = []

  constructor(
    sessionManager: SessionManager,
    adblock: AdblockService,
    sniffer: SnifferManager,
    ytdlp: YtDlpInspector,
    onJobsUpdated?: (jobs: HeadlessProbeJob[]) => void
  ) {
    this.sessionManager = sessionManager
    this.adblock = adblock
    this.sniffer = sniffer
    this.ytdlp = ytdlp
    this.onJobsUpdated = onJobsUpdated
  }

  public getJobs(): HeadlessProbeJob[] {
    return this.jobHistory.map((j) => ({
      ...j,
      results: j.results.map((r) => ({ ...r }))
    }))
  }

  public startProbe(rawUrl: string, partition = PERSIST_PARTITION): HeadlessProbeJob {
    const url = rawUrl.trim().startsWith('http') ? rawUrl.trim() : `https://${rawUrl.trim()}`
    const jobId = crypto.randomUUID()
    const probeTabId = `headless:${jobId}`

    const job: HeadlessProbeJob = {
      id: jobId,
      url,
      status: 'probing',
      stageText: 'Opening hidden muted Chromium session & running extractor probe...',
      results: [],
      startedAt: Date.now()
    }

    this.jobHistory.unshift(job)
    if (this.jobHistory.length > 25) {
      this.jobHistory.pop()
    }

    const sess = this.sessionManager.getSessionByPartition(partition)
    const view = new WebContentsView({
      webPreferences: {
        session: sess,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    view.setVisible(false)
    view.webContents.setAudioMuted(true)

    attachPopupGuard(view.webContents, {
      isHeadless: true,
      adblock: this.adblock
    })

    const active: ActiveProbe = {
      job,
      view,
      probeTabId,
      unsubscribe: null,
      timeoutTimer: null,
      settleTimer: null
    }
    this.probes.set(jobId, active)

    const pushResult = (media: DetectedMedia): void => {
      if (job.results.some((r) => r.url === media.url || r.mediaSignature === media.mediaSignature)) {
        return
      }
      job.results.push({ ...media, tabId: 'headless' })
      job.stageText = `Captured ${job.results.length} stream(s)! Finalizing track metadata...`
      this.broadcast()

      // Give page 2.5s after first hit to finish loading any extra audio/master manifests, then finalize
      if (!active.settleTimer) {
        active.settleTimer = setTimeout(() => {
          this.finishProbe(jobId, 'completed')
        }, 2500)
      }
    }

    active.unsubscribe = this.sniffer.onMediaCaptured((media) => {
      if (media.tabId === probeTabId) {
        pushResult(media)
      }
    })

    this.sniffer.attachToTab(probeTabId, view.webContents, partition, () => ({
      id: probeTabId,
      url,
      title: view.webContents.getTitle() || url,
      isIncognito: partition !== PERSIST_PARTITION,
      isMuted: true,
      isAudible: false,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      blockedAdsCount: 0,
      detectedMediaCount: job.results.length,
      isSiteWhitelisted: false,
      internalRoute: null
    }))

    // Parallel Probe 1: yt-dlp extractor check (catches YouTube / Vimeo / TikTok / X fast)
    void this.ytdlp
      .inspectUrl({ url, tabId: probeTabId, partition, session: sess })
      .then((ytMedia) => {
        if (ytMedia && this.probes.has(jobId)) {
          pushResult(ytMedia)
        }
      })
      .catch(() => {})

    // Parallel Probe 2: Hidden real Chromium load + muted autoplay click simulation
    view.webContents.on('did-finish-load', () => {
      if (!this.probes.has(jobId)) return
      job.stageText = 'Page loaded — triggering muted video player & sniffing network/Blob streams...'
      this.broadcast()

      void view.webContents
        .executeJavaScript(
          `(() => {
            try {
              const clickSelectors = [
                '.vjs-big-play-button',
                '.jw-icon-display',
                '.plyr__control--overlaid',
                '[aria-label*="Play" i]',
                '.play-button',
                'video'
              ];
              for (const sel of clickSelectors) {
                const el = document.querySelector(sel);
                if (el && typeof el.click === 'function') el.click();
              }
              for (const v of document.querySelectorAll('video')) {
                v.muted = true;
                v.play().catch(() => {});
              }
            } catch {}
          })();`,
          true
        )
        .catch(() => {})
    })

    active.timeoutTimer = setTimeout(() => {
      if (job.results.length > 0) {
        this.finishProbe(jobId, 'completed')
      } else {
        this.finishProbe(
          jobId,
          'failed',
          'No downloadable stream detected within 25s (page may require manual CAPTCHA/login in a regular tab).'
        )
      }
    }, 25000)

    this.broadcast()
    void view.webContents.loadURL(url).catch((err) => {
      if (job.results.length === 0) {
        this.finishProbe(jobId, 'failed', err?.message || 'Navigation failed')
      }
    })

    return { ...job }
  }

  /**
   * Used by TokenRefresher to silently replay a source page in a hidden muted tab
   * and wait for a fresh manifest / media URL matching the target signature!
   */
  public refreshStreamCredentials(opts: {
    sourcePageUrl: string
    partition: string
    targetSignature: string
    targetType: string
    timeoutMs?: number
  }): Promise<DetectedMedia | null> {
    return new Promise((resolve) => {
      const probeTabId = `refresh:${crypto.randomUUID()}`
      const sess = this.sessionManager.getSessionByPartition(opts.partition)
      const view = new WebContentsView({
        webPreferences: {
          session: sess,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false
        }
      })
      view.setVisible(false)
      view.webContents.setAudioMuted(true)
      attachPopupGuard(view.webContents, { isHeadless: true, adblock: this.adblock })

      let settled = false
      let unsubscribe: (() => void) | null = null

      const cleanup = (result: DetectedMedia | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe?.()
        this.sniffer.detachFromTab(probeTabId)
        if (!view.webContents.isDestroyed()) {
          view.webContents.close()
        }
        resolve(result)
      }

      unsubscribe = this.sniffer.onMediaCaptured((media) => {
        if (media.tabId !== probeTabId) return
        if (
          media.mediaSignature === opts.targetSignature ||
          media.type === opts.targetType
        ) {
          cleanup(media)
        }
      })

      this.sniffer.attachToTab(probeTabId, view.webContents, opts.partition, () => undefined)

      view.webContents.on('did-finish-load', () => {
        if (settled) return
        void view.webContents
          .executeJavaScript(
            `(() => {
              for (const v of document.querySelectorAll('video')) {
                v.muted = true;
                v.play().catch(() => {});
              }
            })();`,
            true
          )
          .catch(() => {})
      })

      const timer = setTimeout(() => cleanup(null), opts.timeoutMs ?? 22000)
      void view.webContents.loadURL(opts.sourcePageUrl).catch(() => cleanup(null))
    })
  }

  public cancelProbe(jobId: string): void {
    this.finishProbe(jobId, 'failed', 'Cancelled by user')
  }

  private finishProbe(
    jobId: string,
    status: 'completed' | 'failed',
    errorMsg?: string
  ): void {
    const active = this.probes.get(jobId)
    if (!active) return

    if (active.timeoutTimer) clearTimeout(active.timeoutTimer)
    if (active.settleTimer) clearTimeout(active.settleTimer)
    active.unsubscribe?.()
    this.sniffer.detachFromTab(active.probeTabId)

    if (active.view && !active.view.webContents.isDestroyed()) {
      active.view.webContents.close()
    }
    active.view = null
    this.probes.delete(jobId)

    active.job.status = status
    if (status === 'completed') {
      active.job.stageText = `Found ${active.job.results.length} downloadable stream(s)`
    } else {
      active.job.error = errorMsg
      active.job.stageText = errorMsg || 'No streams found'
    }
    this.broadcast()
  }

  private broadcast(): void {
    this.onJobsUpdated?.(this.getJobs())
  }
}
