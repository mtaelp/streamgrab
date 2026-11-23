<div align="center">

# StreamGrab Browser

**A portable, all-in-one desktop browser, native ad/popup shield, dual-layer stream sniffer, and 32–64 thread media downloader for Windows & macOS.**

[![Windows](https://img.shields.io/badge/Windows-x64%20Portable%20EXE-0078D6?logo=windows&logoColor=white)](https://github.com/mtaelp/streamgrab/releases)
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon%20%26%20Intel-000000?logo=apple&logoColor=white)](https://github.com/mtaelp/streamgrab/releases)
[![Release Build](https://github.com/mtaelp/streamgrab/actions/workflows/release.yml/badge.svg)](https://github.com/mtaelp/streamgrab/actions/workflows/release.yml)
[![Electron](https://img.shields.io/badge/Electron-36-47848F?logo=electron&logoColor=white)](#architecture--how-it-works)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](#build-from-source)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](#license)

[Features](#-key-features) • [Screenshots](#-screenshots) • [Download & Quick Start](#-download--quick-start-windows--macos) • [How It Works](#-architecture--how-it-works) • [Build from Source](#-build-from-source) • [GitHub Releases CI](#-automated-windows--macos-releases-github-actions)

</div>

---

![Live Browser & Stream Sniffer](docs/screenshots/02-sniffer.png)

## Overview

**StreamGrab Browser** combines a privacy-focused Chromium browser, real-time stream inspector, and high-concurrency download manager into a single, self-contained application for **Windows (`x64`)** and **macOS (`Apple Silicon` & `Intel`)**. Instead of juggling browser extensions, external CLI scripts, cookie exporters, and adblockers that break on cross-origin `<iframe>` players or `blob:` streams, everything runs natively under one roof:

1. **Browse ad-free** with network-level adblocking and strict clickjacking/pop-under protection.
2. **Play any video** (or paste a page URL into the **Headless Sniffer** without opening the page manually).
3. **Pick exact tracks** — resolution (`4K` / `1080p` / `720p`), audio language, subtitles, or audio-only extraction — and grab at **up to 64 parallel connections** with automatic `FFmpeg` muxing into `.mp4` or `.mkv`.

---

## Key Features

### Dual-Layer Stream Sniffer (Zero-Refetch & Anti-Obfuscation)
- **Layer 1 — Chromium DevTools Protocol (`CDP`):** Attaches `Network` + `Target.setAutoAttach` across the main page, nested cross-origin `<iframe>` embeds, and Dedicated/Shared Workers. Reads manifest bodies directly from Chromium's RAM buffer (`Network.getResponseBody`) so single-use signed tokens are never burned by a second fetch.
- **Layer 2 — Main-World JS & MSE Hooks:** Intercepts `fetch`, `XMLHttpRequest`, `Blob`, `URL.createObjectURL`, `MediaSource.addSourceBuffer`, and Worker `BroadcastChannel` payloads to catch in-memory `blob:` manifests and disguised streams served behind `.txt`, `.png`, or extensionless URLs.
- **Smart Deduplication & Track Grouping:** Automatically groups separate `#EXT-X-MEDIA` audio/subtitle renditions under their parent Master HLS/DASH card and separates short pre-roll ad clips from full-length episodes.
- **Paste-URL Headless Sniffer:** Paste a link to spin up a hidden, muted background `WebContentsView` that auto-triggers playback, captures the stream manifest, and surfaces quality options without manual browsing.

### Power Trio Download & Muxing Engine
| Engine | Best For | Highlights |
| :--- | :--- | :--- |
| **`N_m3u8DL-RE` + `FFmpeg`** | HLS (`.m3u8`), MPEG-DASH (`.mpd`), `AES-128` encrypted streams | 32–64 concurrent segment threads, exact per-host wire header & `no-referrer` replay, multi-audio/subtitle track selection, automatic `.mp4`/`.mkv` muxing |
| **`DirectRangeEngine`** | Direct `.mp4`, `.mkv`, `.webm`, `.zip`, `.exe` files | Built-in 16–64 thread HTTP `Range` splitter with dynamic work-stealing (halves the slowest remaining chunk) and SQLite WAL crash-safe resume |
| **`yt-dlp` + Cookie Jar** | 1,000+ streaming platforms & complex extractors | Deep-scans pages on demand while automatically exporting live Chromium `HttpOnly` session & age-gate cookies in Netscape format |

### Native Adblock & Strict Anti-Popup Shield
- Powered by `@ghostery/adblocker-electron` (**EasyList**, **EasyPrivacy**, **uBlock**, **Peter Lowe**, **AdGuard Regional**, and **AdGuard Popups** filters) for network + cosmetic banner/pre-roll blocking.
- **Strict `PopupGuard`:** Blocks both 0-day cross-origin ad popups *and* sneaky same-domain `302` redirector popups triggered by invisible overlays over video players, while keeping genuine OAuth login dialogs (`Google`, `GitHub`, `Microsoft`, `Apple`, `Discord`) working and offering a non-intrusive `[Open Tab]` toast button when needed.

### Mid-Download `403` Token Auto-Refresh
- If a CDN link's signed token expires mid-download (`HTTP 403`), StreamGrab pauses the task, silently reloads the original watch page in a hidden muted tab, matches the refreshed stream signature, swaps in the new token/headers, and resumes without losing already-downloaded segments.

### 100% True Portable Design
- Zero registry edits and zero files written to `C:\Users\<you>\AppData` during normal portable use.
- All Chromium profiles, cookies, bookmarks, SQLite WAL state (`vidgrab.db`), and downloads live in `data/` and `downloads/` right next to `StreamGrabBrowser-Portable-<version>.exe`.

---

## Screenshots

### 1. Multi-Threaded Power Trio Download Manager
Real-time telemetry across `N_m3u8DL-RE`, multi-range HTTP, and `yt-dlp` tasks with thread counts, segment progress, aggregate speed, and ETA:

![Downloads Manager](docs/screenshots/03-downloads.png)

### 2. Start Dashboard, Private Tabs & Headless Sniffer
Multi-tab Chromium strip with isolated ephemeral **Private** tabs (`incognito` partition), quick stream test targets, bookmarks, and 1-click **Paste-URL Headless Sniffer**:

![Home Dashboard](docs/screenshots/01-home.png)

### 3. Engine Tuning (`1–64` Threads) & Bundled Portable Binaries
Configure up to **64 parallel connections per download** (defeating per-socket CDN rate limits), toggle `403` token auto-refresh, manage domain adblock exceptions, and verify or update companion binaries in place:

![Settings & Portable Binaries](docs/screenshots/04-settings.png)

---

## Download & Quick Start (Windows & macOS)

All 4 companion media binaries (`FFmpeg`, `FFprobe`, `N_m3u8DL-RE`, and `yt-dlp`) are **pre-bundled** inside every release package — no external installs needed.

### Windows (`x64` Single-File Portable `.exe`)
1. Download **`StreamGrabBrowser-Portable-<version>.exe`** from [**Releases**](https://github.com/mtaelp/streamgrab/releases).
2. Place it in any folder (e.g. `D:\StreamGrab\` or a USB SSD) and double-click — **no installer or administrator rights required**.
3. `data/` and `downloads/` are created automatically right next to the `.exe`.

### macOS (`Apple Silicon M1–M4` & `Intel x64`)
1. From [**Releases**](https://github.com/mtaelp/streamgrab/releases), download:
   - **Apple Silicon (`M1` / `M2` / `M3` / `M4`):** `StreamGrabBrowser-macOS-arm64-<version>.dmg` *(or `.zip` for portable folder mode)*
   - **Intel Mac (`x64`):** `StreamGrabBrowser-macOS-x64-<version>.dmg` *(or `.zip`)*
2. Drag **`StreamGrab Browser.app`** to `/Applications` (uses `~/Library/Application Support/StreamGrabBrowser` & `~/Downloads/StreamGrab`), **or** extract the `.zip` into any custom folder/drive to run in self-contained portable mode.
3. *First-launch Gatekeeper note (open-source ad-hoc signed build):* If macOS displays an "unidentified developer" prompt, clear the quarantine attribute once in Terminal:
   ```bash
   xattr -cr "/Applications/StreamGrab Browser.app"
   ```

---

## Architecture & How It Works

```mermaid
flowchart LR
    subgraph Browser["Chromium Browser Shell (Electron 36)"]
        Tabs["WebContentsView Tabs\n(Persistent + Private)"]
        Headless["Headless Muted Probe\n(Paste-URL Auto-Sniffer)"]
        Shield["AdblockService + PopupGuard\n(Network, Cosmetic & 302 Shield)"]
    end

    subgraph Sniffer["Dual-Layer Media Sniffer"]
        CDP["Layer 1: CDP Network + AutoAttach\n(Zero-Refetch RAM Capture + Wire Headers)"]
        Hook["Layer 2: Main-World Preload\n(fetch / XHR / Blob / MSE / Worker)"]
        Parser["ManifestParser\n(HLS Master/Media + MPEG-DASH)"]
    end

    subgraph Trio["Power Trio Download Orchestrator"]
        NM["HlsDashEngine\n(N_m3u8DL-RE + FFmpeg Muxer)"]
        DR["DirectRangeEngine\n(16-64 Thread Work-Stealing Range)"]
        YT["YtDlpEngine\n(yt-dlp + Live Netscape Cookie Jar)"]
    end

    subgraph Storage["Portable Disk Root"]
        DB[("node:sqlite WAL\n(vidgrab.db)")]
        Out["downloads/\n(.mp4 / .mkv / .m4a)"]
    end

    Tabs --> Shield --> CDP & Hook
    Headless --> CDP & Hook
    CDP & Hook --> Parser --> Trio
    Trio <--> DB
    Trio --> Out
```

### Project Structure

```text
├── .github/workflows/
│   └── release.yml                # CI/CD: builds, tests & publishes single-file portable .exe
├── resources/bin/                 # Portable companion binaries (ffmpeg, ffprobe, N_m3u8DL-RE, yt-dlp)
├── scripts/
│   └── setup-binaries.mjs         # Automated downloader & verifier for the 4 Windows x64 binaries
├── src/
│   ├── main/
│   │   ├── adblock/               # Ghostery adblocker + WebRequest listener multiplexer
│   │   ├── binaries/              # Portable binary health checker & self-updater
│   │   ├── browser/               # TabManager (WebContentsView), SessionManager, PopupGuard, Stealth
│   │   ├── downloader/            # DownloadOrchestrator, HlsDashEngine, DirectRangeEngine, YtDlpEngine
│   │   ├── logger/                # Structured JSONL diagnostic logger for sniffer/popup debugging
│   │   ├── portable/              # PortablePaths & Chromium TLS RuntimeFetch
│   │   ├── sniffer/               # CDP + Main-World SnifferManager, HeadlessSniffer, ManifestParser
│   │   └── storage/               # Built-in node:sqlite WAL persistence (tasks, chunks, history, settings)
│   ├── preload/                   # Context-isolated shell API + frame-wide Main-World sniffer hook
│   ├── renderer/                  # React 19 + Tailwind v4 + Zustand UI (Toolbar, SidePanel, Views)
│   └── shared/                    # Strongly-typed IPC contracts & domain models
└── tests/                         # Unit & real AES-128 HLS + FFmpeg E2E Vitest suite
```

---

## Build from Source

### Prerequisites
- **Windows 10 / 11 (`x64`)** or **macOS 12+ (`arm64` / `x64`)**
- **Node.js 24+** (uses Node's built-in `node:sqlite`)
- **pnpm 11+**

### Setup & Run

```bash
# 1. Clone the repository
git clone https://github.com/mtaelp/streamgrab.git
cd streamgrab

# 2. Install dependencies
pnpm install

# 3. Download & verify platform-native FFmpeg, FFprobe, N_m3u8DL-RE, and yt-dlp into resources/bin/
pnpm run setup:binaries

# 4. Run TypeScript checks & automated unit + E2E tests
pnpm run typecheck
pnpm test

# 5. Launch in development mode
pnpm run dev        # macOS / Windows
# (or .\start-dev.cmd on Windows)
```

### Package Standalone Builds Locally

```bash
# Windows x64 single-file portable executable -> release/StreamGrabBrowser-Portable-1.0.0.exe
pnpm run package:exe

# macOS Apple Silicon (arm64) .dmg + portable .zip
pnpm run package:mac:arm64

# macOS Intel (x64) .dmg + portable .zip
pnpm run package:mac:x64
```

---

## Automated Windows & macOS Releases (GitHub Actions)

[.github/workflows/release.yml](.github/workflows/release.yml) runs a parallel multi-OS matrix on `windows-latest` and `macos-latest`:

1. Fetches & verifies platform-native `FFmpeg`, `FFprobe`, `N_m3u8DL-RE`, and `yt-dlp` binaries for **Windows (`x64`)**, **macOS Apple Silicon (`arm64`)**, and **macOS Intel (`x64`)**.
2. Runs `pnpm run typecheck` and `pnpm test` (executing live AES-128 HLS decryption & FFmpeg muxing E2E tests on **both** Windows and macOS runners).
3. Packages `StreamGrabBrowser-Portable-<version>.exe`, `StreamGrabBrowser-macOS-arm64-<version>.dmg`/`.zip`, `StreamGrabBrowser-macOS-x64-<version>.dmg`/`.zip`, and `SHA256SUMS.txt`, publishing them to **GitHub Releases** whenever you push a `v*` tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

You can also trigger a build manually anytime via **Actions -> Build & Release (Windows + macOS) -> Run workflow**.

---

## Disclaimer

This project is an open-source browser and network protocol research tool intended solely for downloading **user-owned media, public-domain / Creative Commons content, open movies, and streams for which you hold explicit permission**. Users are solely responsible for complying with applicable copyright laws and the Terms of Service of any website they visit. StreamGrab Browser does **not** bypass Widevine/PlayReady DRM.

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).
