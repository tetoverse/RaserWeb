# ⚡ Raser Web — Web Player, Streaming Backend & Link Sharing

<div align="center">

  <img src="assets/icon-512x512.png" width="128" height="128" alt="Raser Web Logo" />

  <h3>Material You 3 Web Music Player & High-Speed Streaming Backend for Raser</h3>

  [![Desktop App](https://img.shields.io/github/v/release/tetoverse/Raser?label=Raser%20Desktop&color=6366f1&style=for-the-badge)](https://github.com/tetoverse/Raser/releases/latest)
  [![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
  [![Live App](https://img.shields.io/badge/Live-app.raserapp.online-ec4899?style=for-the-badge)](https://app.raserapp.online)
  [![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](https://github.com/tetoverse/Raser/blob/main/LICENSE)

  <p align="center">
    <b>Raser Web</b> powers both the browser-based <b>Material You 3</b> music player and the production streaming/metadata API used by the <a href="https://github.com/tetoverse/Raser"><b>Raser</b></a> native desktop app. It delivers sub-second YouTube Music &amp; SoundCloud streaming, duration-matched track resolution, artist profiles, synced lyrics, and 7-character shareable links.
  </p>

</div>

---

## ✨ Key Capabilities

### 🎧 Dual-Tier Audio Streaming Engine (`server.js`)
- **Fast Tier (Sub-300ms Start):** In-process YouTube iOS Innertube resolver with persistent PO-Token & stream caching (`data/stream_cache.json`) for instant initial playback.
- **Full Tier (Seamless Range Continuation):** Background `yt-dlp` resolution seamlessly pumps remaining byte ranges (`pumpRemainderFromUrl`) into the active HTTP response with zero audible gaps.
- **SoundCloud & HLS Support:** Direct SoundCloud API v2 resolution and continuous HLS (`.m3u8`) segment piping with automatic YouTube fallback when tracks are restricted.
- **Duration-Matched Track Resolution:** Uses `pickBestSearchResult` with `targetDuration` verification to filter out mismatched music videos, live recordings, or extended versions so imported Spotify/Apple/Deezer playlists stay in sync.

### 🎨 Full Material You 3 Web Player (`desktop-web/`)
- **Dynamic Material You 3 UI:** Adaptive color extraction from album art, morphing M3 covers, wavy scrubber bar, fullscreen TV Karaoke mode, and responsive mobile layout (`mobile-ui.js` / `mobile.css`).
- **Artist Profiles & Search (`/api/artist`):** Live artist metadata, verified badges, fan counts, and track listings for both search cards and artist pages.
- **Synced Lyrics (`/api/lyrics`, `/api/lyrics-words`):** Time-synced line and word-level lyrics powered by `lrclib.net`.
- **MediaSession API & Keyboard Shortcuts:** Lock screen / media key controls, `Space` (Play/Pause), `← / →` (Seek ±5s), `↑ / ↓` (Volume ±5%), `M` (Mute), `L` (Lyrics), and `F11` (Fullscreen).

### ⚡ 7-Character Short Links (`/s/:code`) & Search (`/search`)
- **Short Links:** Share links are converted to clean 7-character URLs (`https://app.raserapp.online/s/<code>`) with server-side metadata injection and automatic deduplication (`POST /api/shorten`).
- **Direct URL & Search:** Paste any YouTube / YouTube Music link or search directly via `/search`.
- **Cloud Auth & Sync:** Firebase-backed desktop/web authentication (`/api/desktop-auth-session`) and library sync.

---

## 🔌 Core API Endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `GET /` | Serves the full Material You 3 web player (`desktop-web/`) or shared track player |
| `GET /search` | Standalone song search & share-link generator |
| `GET /s/:code` | Resolves 7-character short share links with preloaded metadata |
| `POST /api/shorten` | Generates deduplicated 7-character short links |
| `GET /api/search` | Searches YouTube Music / iTunes / SoundCloud & direct YouTube URLs |
| `GET /api/artist` | Fetches artist avatar, fan count, and tracks for search & artist pages |
| `POST /api/vibe` | Generates personalized wave/radio recommendations from user seeds |
| `GET /api/stream` | Direct dual-tier audio stream (`id`, `url`, `duration`, `platform`, `quality`) |
| `GET /api/stream-info` | Returns resolved/proxied stream metadata (`streamUrl`, `rawStreamUrl`, `isHls`) |
| `GET /api/audio-proxy` | Range-capable audio proxy with seamless Tier-2 continuation |
| `GET /api/lyrics` | Fetches time-synced lyrics via `lrclib.net` |
| `POST /api/resolve-ids` | Batch-resolves track metadata to YouTube video IDs |

---

## 🛠️ Running Locally

### Prerequisites
- **Node.js:** v18+
- **Optional (for full Tier-2 stream resolution):** `yt-dlp` available in `PATH` (falls back to `https://app.raserapp.online` if unavailable locally)

### Start Server
```bash
# 1. Clone repository
git clone https://github.com/tetoverse/RaserWeb.git
cd RaserWeb

# 2. Install dependencies
npm install

# 3. Start the server (default port 3850)
npm start
```

---

## 📂 Project Structure

```text
RaserWeb/
├── server.js              # Node.js HTTP server, dual-tier audio proxy & APIs
├── desktop-web/           # Material You 3 Web Player (index.html, app.js, styles.css, mobile.css)
├── search.html            # Standalone /search & link-generator page
├── webplayer.html         # Shared track player view
├── auth-desktop.html      # Desktop OAuth callback bridge
├── assets/                # App icons, SVGs, and client libraries
├── data/                  # Persistent stream cache, resolved IDs, i18n & PO-token cache
└── scripts/               # Atomic VPS deployment & diagnostic scripts
```

---

## 📄 License

This project is licensed under the MIT License — developed with ❤️ by **[tetoverse](https://github.com/tetoverse)**.
