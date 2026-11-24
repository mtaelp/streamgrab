import { ipcRenderer, webFrame } from 'electron'

const IPC_BLOB_CHANNEL = 'internal:sniffer-blob'
const IPC_VIDEO_META_CHANNEL = 'internal:sniffer-video-meta'
const IPC_DIAG_CHANNEL = 'internal:sniffer-diag'

// Per-frame secret event names so zero global properties are exposed on window
const randSuffix = `${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
const BLOB_EVENT = `__sg_b_${randSuffix}`
const META_EVENT = `__sg_m_${randSuffix}`
const DIAG_EVENT = `__sg_d_${randSuffix}`
const YT_AD_EVENT = `__sg_y_${randSuffix}`

window.addEventListener(
  BLOB_EVENT,
  (ev: Event) => {
    const custom = ev as CustomEvent<{
      manifestText: string
      blobUrl: string
      kind: 'hls' | 'dash'
      frameUrl: string
      pageTitle: string
    }>
    if (custom.detail && typeof custom.detail.manifestText === 'string') {
      ipcRenderer.send(IPC_BLOB_CHANNEL, custom.detail)
    }
  },
  true
)

window.addEventListener(
  META_EVENT,
  (ev: Event) => {
    const custom = ev as CustomEvent<{
      durationSec?: number
      videoWidth?: number
      videoHeight?: number
      poster?: string
      pageTitle?: string
      codecs?: string[]
      frameUrl: string
    }>
    if (custom.detail) {
      ipcRenderer.send(IPC_VIDEO_META_CHANNEL, custom.detail)
    }
  },
  true
)

window.addEventListener(
  DIAG_EVENT,
  (ev: Event) => {
    const custom = ev as CustomEvent<{
      category: string
      event: string
      data: unknown
    }>
    if (custom.detail) {
      ipcRenderer.send(IPC_DIAG_CHANNEL, custom.detail)
    }
  },
  true
)

window.addEventListener(
  YT_AD_EVENT,
  (ev: Event) => {
    const custom = ev as CustomEvent<{ count: number }>
    ipcRenderer.send('sg-internal:youtube-ad-pruned', custom.detail?.count || 1)
  },
  true
)

// Brave-Style Synchronous document_start YouTube Ad & Anti-Adblock Shield
try {
  const host = (location.hostname || '').toLowerCase()
  const isYouTubeHost =
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com') ||
    host === 'youtubekids.com' ||
    host.endsWith('.youtubekids.com')

  if (isYouTubeHost) {
    const shieldEnabled = Boolean(
      ipcRenderer.sendSync('sg-internal:should-shield-frame', location.href)
    )
    if (shieldEnabled) {
      // 1. Blink user-origin CSS (leaves zero <style> nodes in DOM so anti-adblock scripts cannot detect it)
      webFrame.insertCSS(
        `
        ytd-ad-slot-renderer,
        ytd-in-feed-ad-layout-renderer,
        ytd-banner-promo-renderer,
        ytd-statement-banner-renderer,
        ytd-display-ad-renderer,
        ytd-promoted-sparkles-web-renderer,
        ytd-promoted-video-renderer,
        ytd-compact-promoted-video-renderer,
        ytd-action-companion-ad-renderer,
        ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
        ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer),
        ytm-promoted-sparkles-web-renderer,
        #masthead-ad,
        #player-ads,
        #merch-shelf,
        .ytd-mealbar-promo-renderer,
        .ytp-ad-overlay-container,
        .ytp-ad-message-container,
        .ytp-featured-product {
          display: none !important;
        }
        `,
        { cssOrigin: 'user' }
      )

      // 2. Synchronous T=0 Main-World Player JSON Ad-Pruner (Brave / uBlock json-prune technique)
      const ytShieldCode = `(() => {
        try {
          const YT_AD_EVENT = ${JSON.stringify(YT_AD_EVENT)};
          const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];

          const prunePlayerPayload = (obj) => {
            if (!obj || typeof obj !== 'object') return obj;
            let pruned = 0;
            for (const k of AD_KEYS) {
              if (k in obj && obj[k] !== undefined) {
                delete obj[k];
                pruned++;
              }
            }
            if (obj.playerResponse && typeof obj.playerResponse === 'object') {
              for (const k of AD_KEYS) {
                if (k in obj.playerResponse) {
                  delete obj.playerResponse[k];
                  pruned++;
                }
              }
            }
            if (Array.isArray(obj.onResponseReceivedEndpoints)) {
              for (const ep of obj.onResponseReceivedEndpoints) {
                if (ep && typeof ep === 'object' && ep.reloadContinuationItemsCommand) {
                  const items = ep.reloadContinuationItemsCommand.continuationItems;
                  if (Array.isArray(items)) {
                    ep.reloadContinuationItemsCommand.continuationItems = items.filter(
                      (it) => !(it && (it.adSlotRenderer || it.SearchPyvRenderer))
                    );
                  }
                }
              }
            }
            if (pruned > 0) {
              try {
                window.dispatchEvent(new CustomEvent(YT_AD_EVENT, { detail: { count: 1 } }));
              } catch {}
            }
            return obj;
          };

          // Trap inline <head> window.ytInitialPlayerResponse & window.ytInitialData before Polymer boots
          for (const globalProp of ['ytInitialPlayerResponse', 'ytInitialData']) {
            let currentVal = window[globalProp];
            if (currentVal && typeof currentVal === 'object') {
              prunePlayerPayload(currentVal);
            }
            try {
              Object.defineProperty(window, globalProp, {
                configurable: true,
                enumerable: true,
                get() {
                  return currentVal;
                },
                set(nextVal) {
                  currentVal = prunePlayerPayload(nextVal);
                }
              });
            } catch {}
          }

          const isYtPlayerApi = (u) =>
            typeof u === 'string' &&
            (u.includes('/youtubei/v1/player') || u.includes('/youtubei/v1/next'));

          // Prune SPA fetch() responses for /youtubei/v1/player and /youtubei/v1/next
          const origJson = Response.prototype.json;
          Response.prototype.json = async function () {
            const data = await origJson.apply(this, arguments);
            try {
              if (isYtPlayerApi(this.url)) {
                return prunePlayerPayload(data);
              }
            } catch {}
            return data;
          };

          const origText = Response.prototype.text;
          Response.prototype.text = async function () {
            const txt = await origText.apply(this, arguments);
            try {
              if (isYtPlayerApi(this.url) && txt && txt.charCodeAt(0) === 123) {
                const parsed = JSON.parse(txt);
                prunePlayerPayload(parsed);
                return JSON.stringify(parsed);
              }
            } catch {}
            return txt;
          };

          // Instant fallback skipper if a server-stitched ad frame ever enters #movie_player
          let mutedByShield = false;
          const skipServerStitchedAd = () => {
            try {
              const player = document.getElementById('movie_player');
              if (!player) return;
              const video = player.querySelector('video.html5-main-video') || player.querySelector('video');
              const isAd =
                player.classList.contains('ad-showing') ||
                player.classList.contains('ad-interrupting');
              if (!isAd) {
                if (mutedByShield && video) {
                  mutedByShield = false;
                  video.muted = false;
                }
                return;
              }

              const skipBtn = player.querySelector(
                '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-overlay-close-button'
              );
              if (skipBtn && typeof skipBtn.click === 'function') {
                skipBtn.click();
              }

              if (video && Number.isFinite(video.duration) && video.duration > 0 && video.duration < 300) {
                if (!video.muted) {
                  video.muted = true;
                  mutedByShield = true;
                }
                video.currentTime = video.duration;
              }
            } catch {}
          };

          const attachAdObserver = () => {
            const obs = new MutationObserver(skipServerStitchedAd);
            obs.observe(document.documentElement, {
              subtree: true,
              attributes: true,
              attributeFilter: ['class']
            });
          };
          if (document.documentElement) {
            attachAdObserver();
          } else {
            document.addEventListener('DOMContentLoaded', attachAdObserver, { once: true });
          }
        } catch {}
      })();`

      void webFrame.executeJavaScript(ytShieldCode, false)
    }
  }
} catch {
  // Ignore restricted/sandboxed frames
}

const mainWorldHookCode = `(() => {
  try {
    const BLOB_EVENT = ${JSON.stringify(BLOB_EVENT)};
    const META_EVENT = ${JSON.stringify(META_EVENT)};
    const DIAG_EVENT = ${JSON.stringify(DIAG_EVENT)};
    const WORKER_BC_NAME = ${JSON.stringify(`__sg_w_${randSuffix}`)};
    const blobTextMap = new WeakMap();
    const workerBlobUrls = new Set();
    const observedCodecs = new Set();
    const reportedUrls = new Set();

    const emitDiag = (category, event, data) => {
      try {
        window.dispatchEvent(new CustomEvent(DIAG_EVENT, {
          detail: { category, event, data: { ...data, frameUrl: location.href, isTop: window === window.top } }
        }));
      } catch {}
    };

    // Instrument window.open in Main World (captures exact call arguments + JS stack trace!)
    if (typeof window.open === 'function') {
      const origWindowOpen = window.open;
      window.open = function(url, target, features) {
        const stack = (new Error().stack || '').split('\\n').slice(1, 5).map(s => s.trim()).join(' <- ');
        emitDiag('WINDOW_OPEN_JS', 'window.open_called', {
          url: String(url || ''),
          target: String(target || ''),
          features: String(features || ''),
          stack
        });
        return origWindowOpen.apply(this, arguments);
      };
    }

    // Instrument DOM clicks / pointerdowns (catches invisible z-index:999999 ad overlays & clickjacked <a target="_blank">!)
    document.addEventListener('pointerdown', (e) => {
      try {
        const el = e.target;
        if (!el || !el.tagName) return;
        const anchor = el.closest ? el.closest('a') : null;
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        emitDiag('DOM_CLICK', 'pointerdown', {
          x: Math.round(e.clientX),
          y: Math.round(e.clientY),
          tag: el.tagName,
          id: el.id || undefined,
          cls: typeof el.className === 'string' ? el.className.slice(0, 100) : undefined,
          position: cs.position,
          zIndex: cs.zIndex,
          opacity: cs.opacity,
          rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
          anchorHref: anchor ? anchor.href : undefined,
          anchorTarget: anchor ? anchor.target : undefined
        });
      } catch {}
    }, true);

    // Listen for manifests caught inside Dedicated Web Workers (e.g., hls.js enableWorker: true!)
    let workerChannel = null;
    try {
      if (typeof BroadcastChannel === 'function') {
        workerChannel = new BroadcastChannel(WORKER_BC_NAME);
        workerChannel.onmessage = (ev) => {
          const d = ev && ev.data;
          if (d && typeof d.manifestText === 'string' && d.kind) {
            emitManifest(d.manifestText, d.url || location.href, d.kind);
          }
        };
      }
    } catch {}

    const emitManifest = (manifestText, url, kind) => {
      try {
        if (!manifestText || !kind) return;
        const sig = url + '|' + manifestText.length;
        if (reportedUrls.has(sig)) return;
        reportedUrls.add(sig);
        window.dispatchEvent(new CustomEvent(BLOB_EVENT, {
          detail: {
            manifestText,
            blobUrl: url || location.href,
            kind,
            frameUrl: location.href,
            pageTitle: document.title || ''
          }
        }));
      } catch {}
    };

    const detectManifestKind = (text) => {
      if (typeof text !== 'string' || text.length < 7) return null;
      const head = text.slice(0, 1024).trimStart();
      if (head.startsWith('#EXTM3U')) return 'hls';
      if (head.includes('<MPD') && head.includes('urn:mpeg:dash')) return 'dash';
      if (head.startsWith('<?xml') && text.slice(0, 3072).includes('<MPD')) return 'dash';
      return null;
    };

    const decodeBytesIfManifest = (buf) => {
      try {
        const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        if (view.byteLength < 7 || view.byteLength > 4 * 1024 * 1024) return null;
        const headStr = new TextDecoder('utf-8', { fatal: false }).decode(view.subarray(0, Math.min(512, view.byteLength))).trimStart();
        if (!headStr.startsWith('#EXTM3U') && !headStr.includes('<MPD') && !headStr.startsWith('<?xml')) {
          return null;
        }
        const fullText = new TextDecoder('utf-8', { fatal: false }).decode(view);
        const kind = detectManifestKind(fullText);
        return kind ? { text: fullText, kind } : null;
      } catch {
        return null;
      }
    };

    const extractTextFromParts = (parts) => {
      if (!Array.isArray(parts) || parts.length === 0) return null;
      let totalLen = 0;
      const chunks = [];
      for (const part of parts) {
        if (typeof part === 'string') {
          totalLen += part.length;
          if (totalLen > 4 * 1024 * 1024) return null;
          chunks.push(part);
        } else if (part instanceof ArrayBuffer) {
          if (part.byteLength > 4 * 1024 * 1024) return null;
          totalLen += part.byteLength;
          chunks.push(new TextDecoder('utf-8', { fatal: false }).decode(part));
        } else if (ArrayBuffer.isView(part)) {
          if (part.byteLength > 4 * 1024 * 1024) return null;
          totalLen += part.byteLength;
          chunks.push(new TextDecoder('utf-8', { fatal: false }).decode(part));
        } else {
          return null;
        }
      }
      return chunks.join('');
    };

    // 1. Hook window.Blob & URL.createObjectURL (catches blob:https://... playlists AND injects Worker fetch/XHR hooks into blob: JS workers!)
    const workerBootstrapPrefix = \`(() => {
      try {
        const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(\${JSON.stringify(WORKER_BC_NAME)}) : null;
        if (!bc) return;
        const detect = (t) => {
          if (typeof t !== 'string' || t.length < 7) return null;
          const h = t.slice(0, 1024).trimStart();
          if (h.startsWith('#EXTM3U')) return 'hls';
          if (h.includes('<MPD') || (h.startsWith('<?xml') && t.slice(0, 3072).includes('<MPD'))) return 'dash';
          return null;
        };
        if (typeof self.fetch === 'function') {
          const ofetch = self.fetch;
          self.fetch = async function(...a) {
            const r = await ofetch.apply(this, a);
            try {
              const u = r.url || (typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '');
              const cl = Number(r.headers && r.headers.get('content-length') || 0);
              if (r.ok && cl <= 4194304 && r.body) {
                const c = r.clone();
                (async () => {
                  const rd = c.body.getReader();
                  try {
                    const f = await rd.read();
                    if (f.done || !f.value) return;
                    const ht = new TextDecoder().decode(f.value.subarray(0, Math.min(512, f.value.byteLength))).trimStart();
                    if (!ht.startsWith('#EXTM3U') && !ht.includes('<MPD') && !ht.startsWith('<?xml')) {
                      await rd.cancel().catch(() => {});
                      return;
                    }
                    const parts = [f.value];
                    let tot = f.value.byteLength;
                    while (tot < 4194304) {
                      const n = await rd.read();
                      if (n.done || !n.value) break;
                      parts.push(n.value);
                      tot += n.value.byteLength;
                    }
                    const m = new Uint8Array(tot);
                    let off = 0;
                    for (const p of parts) { m.set(p, off); off += p.byteLength; }
                    const txt = new TextDecoder().decode(m);
                    const k = detect(txt);
                    if (k) bc.postMessage({ manifestText: txt, url: u, kind: k });
                  } catch {} finally { rd.releaseLock(); }
                })();
              }
            } catch {}
            return r;
          };
        }
        if (typeof self.XMLHttpRequest === 'function') {
          const oOpen = self.XMLHttpRequest.prototype.open;
          const oSend = self.XMLHttpRequest.prototype.send;
          self.XMLHttpRequest.prototype.open = function(m, u, ...rest) {
            try { this.__sgU = String(u || ''); } catch {}
            return oOpen.call(this, m, u, ...rest);
          };
          self.XMLHttpRequest.prototype.send = function(...a) {
            try {
              this.addEventListener('load', function() {
                try {
                  if (this.status < 200 || this.status >= 400) return;
                  const u = this.responseURL || this.__sgU || '';
                  const rt = this.responseType || '';
                  let txt = '';
                  if (rt === '' || rt === 'text') {
                    txt = this.responseText || '';
                  } else if (rt === 'arraybuffer' && this.response instanceof ArrayBuffer && this.response.byteLength <= 4194304) {
                    const head = new TextDecoder().decode(new Uint8Array(this.response, 0, Math.min(512, this.response.byteLength))).trimStart();
                    if (head.startsWith('#EXTM3U') || head.includes('<MPD') || head.startsWith('<?xml')) {
                      txt = new TextDecoder().decode(new Uint8Array(this.response));
                    }
                  }
                  const k = detect(txt);
                  if (k) bc.postMessage({ manifestText: txt, url: u, kind: k });
                } catch {}
              });
            } catch {}
            return oSend.apply(this, a);
          };
        }
      } catch {}
    })();\\n\`;

    const OrigBlob = window.Blob;
    if (typeof OrigBlob === 'function') {
      const WrappedBlob = function(blobParts, options) {
        let finalParts = blobParts;
        let capturedHit = null;
        try {
          const text = extractTextFromParts(blobParts);
          const kind = text ? detectManifestKind(text) : null;
          if (text && kind) {
            capturedHit = { text, kind };
          } else {
            const mime = String((options && options.type) || '').toLowerCase();
            const looksLikeJsWorker =
              mime.includes('javascript') ||
              (typeof text === 'string' &&
                text.length > 200 &&
                (text.includes('XMLHttpRequest') || text.includes('fetch')) &&
                (text.includes('self.') || text.includes('onmessage')));
            if (looksLikeJsWorker && Array.isArray(blobParts)) {
              finalParts = [workerBootstrapPrefix, ...blobParts];
            }
          }
        } catch {}
        const instance = new OrigBlob(finalParts, options);
        if (capturedHit) {
          blobTextMap.set(instance, capturedHit);
        }
        return instance;
      };
      WrappedBlob.prototype = OrigBlob.prototype;
      Object.setPrototypeOf(WrappedBlob, OrigBlob);
      window.Blob = WrappedBlob;
    }

    if (window.URL && typeof window.URL.createObjectURL === 'function') {
      const origCreateObjectURL = window.URL.createObjectURL.bind(window.URL);
      window.URL.createObjectURL = function(obj) {
        const url = origCreateObjectURL(obj);
        try {
          const hit = blobTextMap.get(obj);
          if (hit) {
            emitManifest(hit.text, url, hit.kind);
          }
        } catch {}
        return url;
      };
    }

    // 2. Hook window.fetch (peeks first 512 bytes of cloned stream so disguised .txt/.png/.html manifests are caught at zero memory cost!)
    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const resp = await origFetch.apply(this, args);
        try {
          const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          const finalUrl = resp.url || reqUrl;
          const cl = Number(resp.headers && resp.headers.get('content-length') || 0);
          if (resp.ok && cl <= 4 * 1024 * 1024 && resp.body) {
            const clone = resp.clone();
            (async () => {
              const reader = clone.body.getReader();
              try {
                const first = await reader.read();
                if (first.done || !first.value) return;
                const headTxt = new TextDecoder('utf-8', { fatal: false }).decode(
                  first.value.subarray(0, Math.min(512, first.value.byteLength))
                ).trimStart();
                if (!headTxt.startsWith('#EXTM3U') && !headTxt.includes('<MPD') && !headTxt.startsWith('<?xml')) {
                  await reader.cancel().catch(() => {});
                  return;
                }
                const chunks = [first.value];
                let total = first.value.byteLength;
                while (total < 4 * 1024 * 1024) {
                  const next = await reader.read();
                  if (next.done || !next.value) break;
                  chunks.push(next.value);
                  total += next.value.byteLength;
                }
                const merged = new Uint8Array(total);
                let offset = 0;
                for (const c of chunks) {
                  merged.set(c, offset);
                  offset += c.byteLength;
                }
                const fullText = new TextDecoder('utf-8', { fatal: false }).decode(merged);
                const kind = detectManifestKind(fullText);
                if (kind) emitManifest(fullText, finalUrl, kind);
              } catch {} finally {
                reader.releaseLock();
              }
            })();
          }
        } catch {}
        return resp;
      };
    }

    // 3. Hook XMLHttpRequest (used by hls.js, jwplayer, FirePlayer, PlayerJS, video.js)
    if (typeof window.XMLHttpRequest === 'function') {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        try {
          this.__sgUrl = typeof url === 'string' ? url : String(url || '');
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        try {
          this.addEventListener('load', function() {
            try {
              if (this.status < 200 || this.status >= 400) return;
              const finalUrl = this.responseURL || this.__sgUrl || location.href;
              const rType = this.responseType || '';
              if (rType === '' || rType === 'text') {
                const txt = this.responseText;
                if (txt && txt.length <= 4 * 1024 * 1024) {
                  const kind = detectManifestKind(txt);
                  if (kind) emitManifest(txt, finalUrl, kind);
                }
              } else if (rType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
                const hit = decodeBytesIfManifest(this.response);
                if (hit) emitManifest(hit.text, finalUrl, hit.kind);
              }
            } catch {}
          });
        } catch {}
        return origSend.apply(this, args);
      };
    }

    // 4. Hook MediaSource codecs (logs exact video/audio codecs initialized by MSE player!)
    if (window.MediaSource && window.MediaSource.prototype && typeof window.MediaSource.prototype.addSourceBuffer === 'function') {
      const origAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;
      window.MediaSource.prototype.addSourceBuffer = function(mimeType) {
        try {
          if (typeof mimeType === 'string') {
            observedCodecs.add(mimeType);
            emitDiag('MSE_CODEC', 'addSourceBuffer', { mimeType });
          }
        } catch {}
        return origAddSourceBuffer.apply(this, arguments);
      };
    }

    // 5. Track ALL <video> elements (picking the longest/largest active video when transitioning from pre-roll ad -> main episode!)
    let lastReportedKey = '';
    const reportVideoMeta = () => {
      try {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return;
        let bestVideo = null;
        let bestDur = 0;
        for (const v of videos) {
          const d = Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : 0;
          if (d >= bestDur) {
            bestDur = d;
            bestVideo = v;
          }
        }
        if (!bestVideo) bestVideo = videos[0];
        const dur = bestDur > 0 ? bestDur : undefined;
        const poster = bestVideo.poster || undefined;
        const vw = bestVideo.videoWidth || undefined;
        const vh = bestVideo.videoHeight || undefined;
        const key = [dur || 0, vw || 0, vh || 0, poster || ''].join('|');
        if (key !== lastReportedKey && (dur || poster || vh)) {
          lastReportedKey = key;
          emitDiag('VIDEO_ELEMENT', 'video_meta_changed', {
            durationSec: dur,
            videoWidth: vw,
            videoHeight: vh,
            currentSrc: bestVideo.currentSrc || bestVideo.src || '',
            totalVideoTagsInFrame: videos.length
          });
          window.dispatchEvent(new CustomEvent(META_EVENT, {
            detail: {
              durationSec: dur,
              videoWidth: vw,
              videoHeight: vh,
              poster,
              pageTitle: document.title || '',
              codecs: Array.from(observedCodecs),
              frameUrl: location.href
            }
          }));
        }
      } catch {}
    };

    document.addEventListener('loadedmetadata', reportVideoMeta, true);
    document.addEventListener('durationchange', reportVideoMeta, true);
    document.addEventListener('playing', reportVideoMeta, true);
  } catch {}
})();`

try {
  void webFrame.executeJavaScript(mainWorldHookCode, false)
} catch {
  // Ignore sandboxed data frames where script injection is disallowed
}
