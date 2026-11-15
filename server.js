let trace = (p) => p;
let wrapAsync = (fn) => fn;
try {
  const ht = require('hang-trace');
  if (ht && typeof ht.trace === 'function') trace = ht.trace;
  if (ht && typeof ht.wrapAsync === 'function') wrapAsync = ht.wrapAsync;
} catch (_) {}

const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execFile } = require('child_process');

if (dns && typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

let ytdlInstance = null;
try {
  const { Ytdl } = require('@distube/ytdl-core');
  ytdlInstance = new Ytdl();
} catch (_) {}

const streamCache = new Map(); // key -> { url, expireAt }
const inflightResolutions = new Map();
const inflightFullResolutions = new Map();
const idMapCache = new Map(); // query/id -> youtubeVideoId

function normalizeTrackKey(str) {
  if (!str || typeof str !== 'string') return '';
  return str.toLowerCase().replace(/[\(\[\{].*?[\)\]\}]/g, '').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

const STREAM_CACHE_FILE = path.join(__dirname, 'data', 'stream_cache.json');
const ID_MAP_CACHE_FILE = path.join(__dirname, 'data', 'resolved_ids.json');

function loadStreamCacheFromDisk() {
  try {
    if (fs.existsSync(STREAM_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STREAM_CACHE_FILE, 'utf8'));
      const now = Date.now();
      let count = 0;
      for (const [k, v] of Object.entries(data)) {
        if (v && v.url && v.expireAt > now) {
          streamCache.set(k, v);
          count++;
        }
      }
      console.log(`[StreamCache] Restored ${count} active stream entries from persistent disk.`);
    }
  } catch (e) {
    console.warn('[StreamCache] Error restoring cache:', e.message);
  }
}

function loadIdMapCacheFromDisk() {
  try {
    if (fs.existsSync(ID_MAP_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(ID_MAP_CACHE_FILE, 'utf8'));
      let count = 0;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'string') {
          idMapCache.set(k, v);
          count++;
        }
      }
      console.log(`[IdMapCache] Restored ${count} pre-resolved YouTube IDs from disk.`);
    }
  } catch (e) {
    console.warn('[IdMapCache] Error restoring cache:', e.message);
  }
}

let saveStreamCacheTimer = null;
function saveStreamCacheToDisk() {
  if (saveStreamCacheTimer) return;
  saveStreamCacheTimer = setTimeout(() => {
    saveStreamCacheTimer = null;
    try {
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const obj = {};
      const now = Date.now();
      for (const [k, v] of streamCache.entries()) {
        if (v && v.expireAt > now) obj[k] = v;
      }
      fs.writeFileSync(STREAM_CACHE_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }, 3000);
}

let saveIdMapTimer = null;
function saveIdCacheToDisk() {
  if (saveIdMapTimer) return;
  saveIdMapTimer = setTimeout(() => {
    saveIdMapTimer = null;
    try {
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const obj = {};
      for (const [k, v] of idMapCache.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(ID_MAP_CACHE_FILE, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }, 2000);
}

loadStreamCacheFromDisk();
loadIdMapCacheFromDisk();

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64, timeout: 60000 });
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 64, timeout: 60000 });

let serverScClientId = 'qLcgHhXgeEFFaSolTB9I71LBsqncsD93';
let serverScClientIdTs = Date.now();

async function refreshSoundCloudClientId(force = false) {
  if (!force && serverScClientId && (Date.now() - serverScClientIdTs < 30 * 60 * 1000)) {
    return serverScClientId;
  }
  try {
    const html = await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(3500)
    }).then(r => r.text());
    const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
    for (let i = scripts.length - 1; i >= Math.max(0, scripts.length - 5); i--) {
      try {
        const js = await fetch(scripts[i], { signal: AbortSignal.timeout(3500) }).then(r => r.text());
        const m = js.match(/client_id\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
        if (m && m[1]) {
          serverScClientId = m[1];
          serverScClientIdTs = Date.now();
          return serverScClientId;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return serverScClientId;
}

async function resolveScTranscoding(trackObj, cid) {
  if (!trackObj || !trackObj.media || !Array.isArray(trackObj.media.transcodings)) return null;
  const list = trackObj.media.transcodings;
  const prog = list.find(t => t.format && t.format.protocol === 'progressive');
  const hls = list.find(t => t.format && t.format.protocol === 'hls' && !/encrypted/i.test(t.format.mime_type || ''));
  const chosen = prog || hls || list[0];
  if (!chosen || !chosen.url) return null;
  const sep = chosen.url.includes('?') ? '&' : '?';
  const auth = trackObj.track_authorization ? `&track_authorization=${encodeURIComponent(trackObj.track_authorization)}` : '';
  const res = await fetch(`${chosen.url}${sep}client_id=${cid}${auth}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) return null;
  const j = await res.json();
  return (j && j.url) || null;
}

async function fetchDirectSoundCloudStream(scUrlOrId, queryFallback) {
  let cid = await refreshSoundCloudClientId(false);
  const targetStr = String(scUrlOrId || '').trim();
  const idMatch = targetStr.match(/(?:tracks\/|^)(\d{6,})/i);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (idMatch && idMatch[1]) {
        const r = await fetch(`https://api-v2.soundcloud.com/tracks/${idMatch[1]}?client_id=${cid}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.status === 401 || r.status === 403) {
          cid = await refreshSoundCloudClientId(true);
          continue;
        }
        if (r.ok) {
          const tObj = await r.json();
          const u = await resolveScTranscoding(tObj, cid);
          if (u) return u;
        }
      } else if (targetStr.startsWith('http')) {
        const r = await fetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(targetStr)}&client_id=${cid}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.status === 401 || r.status === 403) {
          cid = await refreshSoundCloudClientId(true);
          continue;
        }
        if (r.ok) {
          const tObj = await r.json();
          const u = await resolveScTranscoding(tObj, cid);
          if (u) return u;
        }
      }
      if (queryFallback) {
        const sr = await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(queryFallback)}&limit=5&client_id=${cid}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (sr.status === 401 || sr.status === 403) {
          cid = await refreshSoundCloudClientId(true);
          continue;
        }
        if (sr.ok) {
          const sj = await sr.json();
          const col = (sj && Array.isArray(sj.collection)) ? sj.collection : [];
          const pick = col.find(t => t.duration > 30000 && !t.snipped) || col[0];
          if (pick) {
            const u = await resolveScTranscoding(pick, cid);
            if (u) return u;
          }
        }
      }
      break;
    } catch (_) {}
  }
  // Seamless smart fallback to YouTube search if direct soundcloud stream is restricted
  if (queryFallback) {
    try {
      const q = queryFallback.startsWith('ytsearch') ? queryFallback : `ytsearch1:${queryFallback}`;
      return await resolveAudioStream(q, 'youtube');
    } catch (_) {}
  }
  return null;
}

/**
 * In-process YouTube iOS Innertube Stream Resolver
 * Client: IOS (20.10.4) on iPhone16,2.
 * Resolves direct unencrypted, unthrottled audio streams (itag 140 AAC 128kbps / itag 251 Opus 160kbps)
 * in ~200-350ms without spawning yt-dlp child processes.
 */
function fetchYouTubeInnertubeStream(videoId, preferredQuality = '') {
  return new Promise((resolve, reject) => {
    if (!videoId || typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId.trim())) {
      return reject(new Error(`Invalid YouTube videoId: ${videoId}`));
    }
    const cleanId = videoId.trim();

    const payload = JSON.stringify({
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '20.10.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          userAgent: 'com.google.ios.youtube/20.10.4',
          osName: 'iOS',
          osVersion: '18.3.2.22D82',
          hl: 'en',
          gl: 'US'
        }
      },
      videoId: cleanId
    });

    const req = https.request('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'com.google.ios.youtube/20.10.4',
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '20.10.4'
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`Innertube API returned HTTP ${res.statusCode}`));
          }
          const json = JSON.parse(data);
          const playability = json?.playabilityStatus;
          if (playability && playability.status && playability.status !== 'OK') {
            return reject(new Error(`Innertube unplayable: ${playability.status} (${playability.reason || 'restricted'})`));
          }

          const formats = json?.streamingData?.adaptiveFormats;
          if (!Array.isArray(formats) || formats.length === 0) {
            return reject(new Error('Innertube response missing adaptiveFormats'));
          }

          const audioFormats = formats.filter(f => f && f.url && f.mimeType && f.mimeType.startsWith('audio/'));
          if (audioFormats.length === 0) {
            return reject(new Error('No direct unencrypted audio formats found in Innertube response'));
          }

          const qStr = String(preferredQuality || '').toLowerCase();
          let selected = null;
          if (qStr === 'opus' || qStr === '251') {
            selected = audioFormats.find(f => f.itag === 251) || audioFormats.find(f => f.itag === 140);
          } else if (qStr === 'aac' || qStr === '140') {
            selected = audioFormats.find(f => f.itag === 140) || audioFormats.find(f => f.itag === 251);
          } else {
            // Default: itag 140 (AAC 128kbps in MP4) for universal browser/WebView2 compatibility
            selected = audioFormats.find(f => f.itag === 140) || audioFormats.find(f => f.itag === 251);
          }

          if (!selected) {
            audioFormats.sort((a, b) => (b.bitrate || b.audioBitrate || 0) - (a.bitrate || a.audioBitrate || 0));
            selected = audioFormats[0];
          }

          resolve({
            url: selected.url,
            itag: selected.itag,
            mimeType: selected.mimeType,
            bitrate: selected.bitrate || selected.audioBitrate,
            contentLength: selected.contentLength,
            duration: json?.videoDetails?.lengthSeconds ? parseInt(json.videoDetails.lengthSeconds, 10) : undefined
          });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Innertube request timed out'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Background / Full Stream Resolver via yt-dlp
 * Uses tvhtml5 player client for fast resolution (~3.5s) of un-chunk-locked signed streams
 * that support continuous, unthrottled streaming across all byte ranges (full track duration).
 */
function resolveFullStreamViaYtDlp(targetId, cleanTarget = '', isUrl = false) {
  const cacheKey = targetId || cleanTarget;
  if (!cacheKey) return Promise.reject(new Error('Missing target for full stream resolution'));

  if (inflightFullResolutions.has(cacheKey)) {
    return inflightFullResolutions.get(cacheKey);
  }

  const cached = streamCache.get(cacheKey);
  if (cached && cached.fullUrl && cached.expireAt > Date.now()) {
    return Promise.resolve({
      url: cached.fullUrl,
      itag: cached.itag || 140,
      mimeType: cached.mimeType || 'audio/mp4',
      isFull: true
    });
  }

  const promise = (async () => {
    let resolvedVideoId = targetId;
    if (!resolvedVideoId && (isUrl || cleanTarget.startsWith('ytsearch') || cleanTarget)) {
      const q = cleanTarget.replace(/^ytsearch\d*:/i, '').replace(/^(cand_|dz_|it_|sp_|ym_)/i, '').trim();
      const norm = normalizeTrackKey(q);
      if (norm && idMapCache.has(norm)) {
        resolvedVideoId = idMapCache.get(norm);
      } else if (cleanTarget && idMapCache.has(cleanTarget)) {
        resolvedVideoId = idMapCache.get(cleanTarget);
      } else if (q) {
        try {
          const sRes = await searchYouTubeMusic(q);
          if (Array.isArray(sRes) && sRes[0]?.id) {
            resolvedVideoId = sRes[0].id;
            if (norm) idMapCache.set(norm, resolvedVideoId);
            if (cleanTarget) idMapCache.set(cleanTarget, resolvedVideoId);
            saveIdCacheToDisk();
          } else {
            const wRes = await searchYouTubeInnertubeWeb(q);
            if (Array.isArray(wRes) && wRes[0]?.id) {
              resolvedVideoId = wRes[0].id;
              if (norm) idMapCache.set(norm, resolvedVideoId);
              if (cleanTarget) idMapCache.set(cleanTarget, resolvedVideoId);
              saveIdCacheToDisk();
            }
          }
        } catch (_) {}
      }
    }

    const fallbackTarget = resolvedVideoId ? `https://www.youtube.com/watch?v=${resolvedVideoId}` : (isUrl ? cleanTarget : `ytsearch1:${cleanTarget}`);
    const ytdlpArgs = ['--no-warnings', '--no-playlist', '--extractor-args', 'youtube:player_client=tvhtml5', '-g', '-f', '140/ba/b', fallbackTarget];

    let streamUrl = null;

    // 1. Attempt local yt-dlp first (standard on Debian VPS)
    try {
      streamUrl = await new Promise((resolveYt, rejectYt) => {
        execFile('yt-dlp', ytdlpArgs, { timeout: 20000 }, (err, stdout) => {
          if (!err && stdout && stdout.trim().startsWith('https://')) {
            return resolveYt(stdout.trim().split('\n')[0]);
          }
          execFile('yt-dlp', ['--no-warnings', '--no-playlist', '--js-runtimes', 'node', '-g', '-f', '140/ba/b', fallbackTarget], { timeout: 25000 }, (fErr, fOut) => {
            if (!fErr && fOut && fOut.trim().startsWith('https://')) {
              return resolveYt(fOut.trim().split('\n')[0]);
            }
            rejectYt(fErr || err || new Error('yt-dlp extraction failed'));
          });
        });
      });
    } catch (localYtErr) {
      // 2. Fallback to production VPS endpoint if local yt-dlp is missing (e.g. Windows development / test suite)
      const lookupId = resolvedVideoId || targetId;
      if (lookupId && !isUrl) {
        try {
          const vpsApiUrl = `https://app.raserapp.online/api/stream-info?id=${encodeURIComponent(lookupId)}&forceYtDlp=1`;
          streamUrl = await new Promise((resolveVps, rejectVps) => {
            const vpsReq = https.get(vpsApiUrl, { timeout: 15000, headers: { 'User-Agent': 'RaserLocalDev/1.0' } }, (vpsRes) => {
              let body = '';
              vpsRes.on('data', chunk => body += chunk);
              vpsRes.on('end', () => {
                try {
                  const data = JSON.parse(body);
                  if (data && data.success && data.rawStreamUrl) {
                    return resolveVps(data.rawStreamUrl);
                  }
                  rejectVps(new Error('VPS returned no rawStreamUrl'));
                } catch (e) {
                  rejectVps(e);
                }
              });
            });
            vpsReq.on('error', rejectVps);
          });
        } catch (_) {}
      }

      // 3. Fallback to fast in-process Innertube stream
      if (!streamUrl && targetId) {
        try {
          const fastInfo = await fetchYouTubeInnertubeStream(targetId);
          if (fastInfo && fastInfo.url) {
            streamUrl = fastInfo.url;
          }
        } catch (_) {}
      }
    }

    if (streamUrl) {
      const resObj = { url: streamUrl, itag: 140, mimeType: 'audio/mp4', isFull: true };
      const existing = streamCache.get(cacheKey) || {};
      streamCache.set(cacheKey, {
        ...existing,
        fullUrl: streamUrl,
        url: streamUrl,
        expireAt: Date.now() + 18000000,
        itag: 140,
        mimeType: 'audio/mp4'
      });
      if (targetId && cacheKey !== targetId) {
        streamCache.set(targetId, streamCache.get(cacheKey));
      }
      saveStreamCacheToDisk();
      return resObj;
    }

    throw new Error('No full stream found');
  })().finally(() => {
    inflightFullResolutions.delete(cacheKey);
  });

  inflightFullResolutions.set(cacheKey, promise);
  return promise;
}

/**
 * Resolves full audio stream details (URL, itag, mimeType, contentLength).
 * Dual-tier streaming architecture:
 * 1. Fast Tier: In-process YouTube iOS Innertube resolver (~200-300ms) provides instant playback burst (bytes 0-1048575).
 * 2. Full Tier: Background yt-dlp tvhtml5 resolver (~3.5s) provides un-chunk-locked signed stream for subsequent ranges & full length.
 */
async function resolveAudioStreamDetails(target, platform = '', queryFallback = '', forceRefresh = false, preferredQuality = '', rangeStart = 0) {
  if (!target || typeof target !== 'string') {
    throw new Error('Invalid target for audio stream');
  }
  const cleanTarget = target.trim();

  // SoundCloud handling
  if (platform === 'soundcloud' || cleanTarget.includes('soundcloud.com') || /^\d{6,}$/.test(cleanTarget)) {
    const scUrl = await fetchDirectSoundCloudStream(cleanTarget, queryFallback);
    if (scUrl) {
      return {
        url: scUrl,
        itag: null,
        mimeType: scUrl.includes('.m3u8') ? 'application/x-mpegURL' : 'audio/mpeg',
        isHls: scUrl.includes('.m3u8')
      };
    }
    throw new Error('SoundCloud stream could not be resolved');
  }

  // Extract or search for YouTube Video ID
  const isDirectId = /^[a-zA-Z0-9_-]{11}$/.test(cleanTarget) && !/^(cand_|dz_|it_|sp_|ym_)/i.test(cleanTarget);
  let targetId = isDirectId ? cleanTarget : (extractYouTubeId(cleanTarget) || null);

  // If no targetId, resolve search query in-process via searchYouTubeMusic
  if (!targetId) {
    let searchQuery = '';
    if (cleanTarget.startsWith('ytsearch')) {
      searchQuery = cleanTarget.replace(/^ytsearch\d*:/i, '').trim();
    } else if (queryFallback && queryFallback.trim()) {
      searchQuery = queryFallback.trim();
    } else if (!cleanTarget.startsWith('http://') && !cleanTarget.startsWith('https://')) {
      searchQuery = cleanTarget.replace(/^(cand_|dz_|it_|sp_|ym_)/i, '').trim();
    }

    if (cleanTarget && idMapCache.has(cleanTarget)) {
      targetId = idMapCache.get(cleanTarget);
    }

    if (!targetId && searchQuery) {
      const norm = normalizeTrackKey(searchQuery);
      if (norm && idMapCache.has(norm)) {
        targetId = idMapCache.get(norm);
      }
      if (!targetId) {
        try {
          const searchResults = await searchYouTubeMusic(searchQuery);
          if (Array.isArray(searchResults) && searchResults.length > 0 && searchResults[0].id) {
            targetId = searchResults[0].id;
            if (norm) idMapCache.set(norm, targetId);
            if (cleanTarget) idMapCache.set(cleanTarget, targetId);
            saveIdCacheToDisk();
          }
        } catch (sErr) {
          console.warn('[FastResolver] In-process searchYouTubeMusic note:', sErr.message);
        }
      }
      if (!targetId) {
        try {
          const webResults = await searchYouTubeInnertubeWeb(searchQuery);
          if (Array.isArray(webResults) && webResults.length > 0 && webResults[0].id) {
            targetId = webResults[0].id;
            if (norm) idMapCache.set(norm, targetId);
            if (cleanTarget) idMapCache.set(cleanTarget, targetId);
            saveIdCacheToDisk();
          }
        } catch (_) {}
      }
    }
  }

  const isUrl = cleanTarget.startsWith('http://') || cleanTarget.startsWith('https://');
  const cacheKey = targetId || cleanTarget;
  const isSubsequentRange = typeof rangeStart === 'number' && rangeStart >= 1048576;

  if (forceRefresh) {
    streamCache.delete(cacheKey);
    inflightResolutions.delete(cacheKey);
    inflightFullResolutions.delete(cacheKey);
  } else {
    const cached = streamCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) {
      if (!isSubsequentRange || cached.fullUrl) {
        const chosenUrl = cached.fullUrl || ((isSubsequentRange || !cached.fastUrl) ? (cached.fullUrl || cached.url) : (cached.fastUrl || cached.url));
        return {
          url: chosenUrl,
          itag: cached.itag || 140,
          mimeType: cached.mimeType || 'audio/mp4',
          contentLength: cached.contentLength,
          isFull: !!cached.fullUrl,
          resolvedId: targetId || (isDirectId ? cleanTarget : (cached.resolvedId || null))
        };
      }
    }

    if (!isSubsequentRange && inflightResolutions.has(cacheKey)) {
      return inflightResolutions.get(cacheKey);
    }
    if (isSubsequentRange && inflightFullResolutions.has(cacheKey)) {
      return inflightFullResolutions.get(cacheKey);
    }
  }

  const resolutionPromise = (async () => {
    if (targetId && !isSubsequentRange) {
      // Launch background full resolver to guarantee fullUrl is ready for subsequent chunks
      resolveFullStreamViaYtDlp(targetId, cleanTarget, isUrl).catch(() => {});

      // Fast in-process Innertube resolver for instant sub-250ms playback start
      try {
        const streamDetails = await fetchYouTubeInnertubeStream(targetId, preferredQuality);
        if (streamDetails && streamDetails.url) {
          const existing = streamCache.get(cacheKey) || {};
          streamCache.set(cacheKey, {
            ...existing,
            fastUrl: streamDetails.url,
            url: existing.fullUrl || streamDetails.url,
            expireAt: Date.now() + 18000000,
            itag: streamDetails.itag,
            mimeType: streamDetails.mimeType,
            contentLength: streamDetails.contentLength,
            resolvedId: targetId
          });
          if (cacheKey !== targetId) {
            streamCache.set(targetId, streamCache.get(cacheKey));
          }
          saveStreamCacheToDisk();
          return {
            ...streamDetails,
            resolvedId: targetId
          };
        }
      } catch (inErr) {
        console.warn(`[FastResolver] In-process Innertube note (${targetId}):`, inErr.message, '- falling back to full resolver');
      }
    }

    // Full stream resolver via yt-dlp
    const fullRes = await resolveFullStreamViaYtDlp(targetId, cleanTarget, isUrl);
    return {
      ...fullRes,
      resolvedId: targetId || cleanTarget
    };
  })().finally(() => {
    inflightResolutions.delete(cacheKey);
  });

  inflightResolutions.set(cacheKey, resolutionPromise);
  return resolutionPromise;
}

function resolveAudioStream(target, platform = '', queryFallback = '', forceRefresh = false, preferredQuality = '', rangeStart = 0) {
  // Support both (target, preferredQuality) and (target, platform, queryFallback, forceRefresh, preferredQuality)
  if (arguments.length === 2 && ['aac', 'opus', '140', '251', 'high', 'low'].includes(String(platform).toLowerCase())) {
    preferredQuality = platform;
    platform = '';
  }
  return resolveAudioStreamDetails(target, platform, queryFallback, forceRefresh, preferredQuality, rangeStart).then(res => res.url);
}

/**
 * Pipes HLS audio playlists (.m3u8) as a continuous progressive audio stream.
 * Fetches playlist segments sequentially and writes MP3/AAC audio bytes directly
 * into the HTTP response so HTML5 <audio> elements in desktop/mobile browsers
 * can play SoundCloud and HLS streams seamlessly without requiring Hls.js.
 */
function streamHlsAudio(req, res, playlistUrl) {
  let isAborted = false;
  let activeReq = null;

  const abort = () => {
    isAborted = true;
    if (activeReq) {
      try { activeReq.destroy(); } catch (_) {}
      activeReq = null;
    }
  };

  req.on('close', abort);
  res.on('close', abort);

  let parsed;
  try {
    parsed = new URL(playlistUrl);
  } catch (e) {
    if (!res.headersSent) res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }).end('Invalid playlist URL');
    return;
  }

  const client = parsed.protocol === 'https:' ? https : http;

  const m3u8Req = client.get(playlistUrl, {
    agent: parsed.protocol === 'https:' ? keepAliveHttpsAgent : keepAliveHttpAgent,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000
  }, (m3u8Res) => {
    if (m3u8Res.statusCode >= 400) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }).end('Failed to fetch playlist');
      }
      return;
    }

    let body = '';
    m3u8Res.on('data', chunk => { body += chunk; });
    m3u8Res.on('end', async () => {
      if (isAborted) return;
      const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
      const segmentUrls = [];
      for (const line of lines) {
        if (line.startsWith('#')) continue;
        if (line.startsWith('http://') || line.startsWith('https://')) {
          segmentUrls.push(line);
        } else {
          try {
            segmentUrls.push(new URL(line, playlistUrl).toString());
          } catch (_) {}
        }
      }

      if (segmentUrls.length === 0) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }).end('Empty playlist segments');
        }
        return;
      }

      const isMp3 = playlistUrl.includes('.mp3') || (segmentUrls[0] && segmentUrls[0].includes('.mp3'));
      const contentType = isMp3 ? 'audio/mpeg' : 'audio/mp4';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'public, max-age=86400',
        'X-Accel-Buffering': 'no'
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      for (let i = 0; i < segmentUrls.length; i++) {
        if (isAborted || res.writableEnded) break;
        const segUrl = segmentUrls[i];
        await new Promise((resolveSeg) => {
          if (isAborted || res.writableEnded) return resolveSeg();
          try {
            const segParsed = new URL(segUrl);
            const segClient = segParsed.protocol === 'https:' ? https : http;
            activeReq = segClient.get(segUrl, {
              agent: segParsed.protocol === 'https:' ? keepAliveHttpsAgent : keepAliveHttpAgent,
              headers: { 'User-Agent': 'Mozilla/5.0' },
              timeout: 15000
            }, (segRes) => {
              segRes.on('data', (chunk) => {
                if (!isAborted && !res.writableEnded) {
                  if (!res.write(chunk)) {
                    segRes.pause();
                  }
                }
              });
              res.on('drain', () => {
                if (!isAborted) segRes.resume();
              });
              segRes.on('end', resolveSeg);
              segRes.on('error', resolveSeg);
            });
            activeReq.on('error', resolveSeg);
          } catch (_) {
            resolveSeg();
          }
        });
      }

      if (!res.writableEnded) res.end();
    });
  });

  m3u8Req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }).end('Playlist error: ' + err.message);
    }
  });
}

function pumpRemainderFromUrl(req, res, targetUrl, startByte, totalLength, redirectsLeft = 5) {
  if (res.writableEnded || !res.writable) return;
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    return res.end();
  }
  const client = parsed.protocol === 'https:' ? https : http;
  const headers = {
    'host': parsed.host,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'origin': 'https://www.youtube.com',
    'referer': 'https://www.youtube.com/',
    'range': `bytes=${startByte}-${totalLength ? totalLength - 1 : ''}`
  };

  const remainderReq = client.request(targetUrl, {
    method: 'GET',
    family: 4,
    agent: parsed.protocol === 'https:' ? keepAliveHttpsAgent : keepAliveHttpAgent,
    headers
  }, (remainderRes) => {
    console.log(`[pumpRemainderFromUrl] Upstream status: ${remainderRes.statusCode} for range ${headers['range']}`);
    if (res.writableEnded) {
      remainderRes.destroy();
      return;
    }
    if ([301, 302, 303, 307, 308].includes(remainderRes.statusCode) && remainderRes.headers.location && redirectsLeft > 0) {
      remainderRes.resume();
      const nextUrl = new URL(remainderRes.headers.location, targetUrl).toString();
      return pumpRemainderFromUrl(req, res, nextUrl, startByte, totalLength, redirectsLeft - 1);
    }
    if (remainderRes.statusCode >= 400) {
      console.log(`[pumpRemainderFromUrl] Upstream error: ${remainderRes.statusCode}`);
      remainderRes.resume();
      return res.end();
    }

    remainderRes.on('data', chunk => {
      if (!res.write(chunk)) {
        remainderRes.pause();
      }
    });
    res.on('drain', () => {
      remainderRes.resume();
    });
    remainderRes.on('end', () => {
      if (!res.writableEnded) res.end();
    });
    remainderRes.on('error', () => {
      if (!res.writableEnded) res.end();
    });
  });

  const abort = () => {
    try { remainderReq.destroy(); } catch (_) {}
  };
  req.on('close', abort);
  res.on('close', abort);
  remainderReq.setTimeout(60000, () => {
    remainderReq.destroy();
  });
  remainderReq.on('error', () => {
    if (!res.writableEnded) res.end();
  });
  remainderReq.end();
}

async function handleAudioProxy(req, res, targetUrl, redirectsLeft = 5, options = {}) {
  if (!targetUrl) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Missing url');
  }

  // Handle HLS playlists on stream endpoint: stream segments as continuous audio
  if (options && options.isStreamEndpoint && (targetUrl.includes('.m3u8') || targetUrl.includes('/hls') || targetUrl.includes('cf-hls-media') || targetUrl.includes('playback.media-streaming'))) {
    return streamHlsAudio(req, res, targetUrl);
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Invalid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Unsupported protocol');
  }
  const hostLower = (parsed.hostname || '').toLowerCase();
  if (hostLower === 'localhost' || hostLower === '127.0.0.1' || hostLower === '::1') {
    res.writeHead(403, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Blocked target');
  }

  // Derive targetId if missing from options
  let effectiveTargetId = options.targetId;
  if (!effectiveTargetId) {
    if (parsed.searchParams.has('docid')) {
      effectiveTargetId = parsed.searchParams.get('docid');
    }
    if (!effectiveTargetId) {
      for (const [k, v] of streamCache.entries()) {
        if (v && (v.url === targetUrl || v.fastUrl === targetUrl || v.fullUrl === targetUrl)) {
          effectiveTargetId = k;
          break;
        }
      }
    }
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const forward = { host: parsed.host };
  for (const key of ['range', 'accept', 'accept-language']) {
    if (req.headers[key] !== undefined) forward[key] = req.headers[key];
  }

  const rangeHeader = forward['range'] || '';
  const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
  const rangeStart = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
  const rangeEnd = rangeMatch && rangeMatch[2] ? parseInt(rangeMatch[2], 10) : null;
  const isByteZeroRequest = !rangeHeader || rangeHeader === 'bytes=0-' || (rangeStart === 0 && rangeEnd === null);

  if (hostLower.endsWith('googlevideo.com')) {
    const cParam = (parsed.searchParams.get('c') || '').toUpperCase();

    // Prevent 403 on c=IOS when range >= 1048576: upgrade to full stream if available
    if (cParam === 'IOS' && rangeStart >= 1048576 && effectiveTargetId) {
      let fullUrl = streamCache.get(effectiveTargetId)?.fullUrl;
      if (!fullUrl) {
        try {
          const fullPromise = inflightFullResolutions.get(effectiveTargetId) || resolveFullStreamViaYtDlp(effectiveTargetId);
          const fullDetails = await fullPromise;
          if (fullDetails && fullDetails.url && fullDetails.url !== targetUrl) {
            fullUrl = fullDetails.url;
          }
        } catch (_) {}
      }
      if (fullUrl && fullUrl !== targetUrl) {
        return handleAudioProxy(req, res, fullUrl, redirectsLeft, options);
      }
    }

    if (cParam === 'IOS') {
      // Google Video c=IOS strictly returns 403 on open-ended ranges. Always bound the initial chunk <= 1048575.
      const boundedEnd = (rangeEnd !== null) ? Math.min(rangeEnd, 1048575) : 1048575;
      forward['range'] = `bytes=${rangeStart}-${boundedEnd}`;
    } else if (isByteZeroRequest) {
      forward['range'] = 'bytes=0-';
    }

    forward['origin'] = 'https://www.youtube.com';
    forward['referer'] = 'https://www.youtube.com/';
    if (cParam === 'IOS') {
      forward['user-agent'] = 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
    } else if (cParam === 'ANDROID_VR') {
      forward['user-agent'] = 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
    } else if (cParam === 'ANDROID_MUSIC') {
      forward['user-agent'] = 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14; en_US; sdk_gphone64_x86_64 Build/UE1A.230829.036) gzip';
    } else if (cParam.startsWith('ANDROID')) {
      forward['user-agent'] = 'com.google.android.youtube/19.44.38 (Linux; U; Android 14; en_US; sdk_gphone64_x86_64 Build/UE1A.230829.036) gzip';
    } else {
      forward['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
    }
  } else {
    forward['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }

  const proxyReq = client.request(targetUrl, {
    method: req.method,
    family: 4,
    agent: parsed.protocol === 'https:' ? keepAliveHttpsAgent : keepAliveHttpAgent,
    headers: forward
  }, async (proxyRes) => {
    if (res.writableEnded) {
      proxyRes.destroy();
      return;
    }
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && redirectsLeft > 0) {
      proxyRes.resume();
      const nextUrl = new URL(proxyRes.headers.location, targetUrl).toString();
      return handleAudioProxy(req, res, nextUrl, redirectsLeft - 1, options);
    }
    if (proxyRes.statusCode >= 400) {
      proxyRes.resume();
      // Automatic failover: if c=IOS hit 403 on Google Video, resolve full stream and proxy it
      const cParam = (parsed.searchParams.get('c') || '').toUpperCase();
      if (proxyRes.statusCode === 403 && cParam === 'IOS' && effectiveTargetId && redirectsLeft > 0) {
        try {
          const fullPromise = inflightFullResolutions.get(effectiveTargetId) || resolveFullStreamViaYtDlp(effectiveTargetId);
          const fullDetails = await fullPromise;
          if (fullDetails && fullDetails.url && fullDetails.url !== targetUrl) {
            return handleAudioProxy(req, res, fullDetails.url, redirectsLeft - 1, options);
          }
        } catch (_) {}
      }

      for (const [k, v] of streamCache.entries()) {
        if (v && (v.url === targetUrl || v.fastUrl === targetUrl || v.fullUrl === targetUrl)) {
          streamCache.delete(k);
          break;
        }
      }
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      return res.end('Upstream error');
    }

    const outHeaders = Object.assign({}, proxyRes.headers);
    delete outHeaders['access-control-allow-origin'];
    delete outHeaders['Access-Control-Allow-Origin'];
    delete outHeaders['access-control-allow-credentials'];
    delete outHeaders['x-frame-options'];
    outHeaders['Access-Control-Allow-Origin'] = '*';
    outHeaders['Access-Control-Allow-Headers'] = '*';
    outHeaders['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges';
    outHeaders['X-Accel-Buffering'] = 'no';
    outHeaders['Accept-Ranges'] = 'bytes';

    if (options && options.isStreamEndpoint) {
      outHeaders['Cache-Control'] = 'public, max-age=86400';
      if (!outHeaders['content-type'] || !outHeaders['content-type'].includes('/')) {
        outHeaders['Content-Type'] = options.contentType || 'audio/mp4';
      }
    } else {
      outHeaders['Cache-Control'] = 'no-cache, no-transform';
    }

    const cParam = (parsed.searchParams.get('c') || '').toUpperCase();
    const effectiveTotal = options.seamlessTotalLength || (effectiveTargetId && streamCache.get(effectiveTargetId)?.contentLength) || (outHeaders['content-range'] ? parseInt((outHeaders['content-range'].match(/\/(\d+)/) || [])[1], 10) : null);
    if (effectiveTotal && cParam === 'IOS') {
      const respStart = rangeStart;
      const respEnd = (rangeEnd !== null) ? Math.min(rangeEnd, effectiveTotal - 1) : effectiveTotal - 1;
      outHeaders['content-range'] = `bytes ${respStart}-${respEnd}/${effectiveTotal}`;
      outHeaders['content-length'] = String(respEnd - respStart + 1);
    }

    res.writeHead(proxyRes.statusCode || 200, outHeaders);
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    if (res.socket && typeof res.socket.setNoDelay === 'function') {
      res.socket.setNoDelay(true);
    }

    // Fast-burst initial 64KB chunk (containing MP4 ftyp + moov) without proxy buffering
    let bytesStreamed = 0;
    const FAST_BURST_THRESHOLD = 64 * 1024;
    let bursting = true;

    const onData = (chunk) => {
      bytesStreamed += chunk.length;
      if (bursting) {
        res.write(chunk);
        if (res.socket && typeof res.socket.uncork === 'function') {
          try { res.socket.uncork(); } catch (_) {}
        }
        if (bytesStreamed >= FAST_BURST_THRESHOLD) {
          bursting = false;
        }
      } else {
        if (!res.write(chunk)) {
          proxyRes.pause();
        }
      }
    };

    proxyRes.on('data', onData);
    res.on('drain', () => {
      proxyRes.resume();
    });
    proxyRes.on('end', async () => {
      // Seamless multi-tier stream continuity:
      // If c=IOS reached the end of its 1MB burst on an open-ended request or request extending past 1MB,
      // seamlessly pump the remaining bytes from Tier 2 fullUrl into the SAME response!
      const totalStreamedOffset = rangeStart + bytesStreamed;
      const wantsMoreBytes = (rangeEnd === null) || (rangeEnd >= totalStreamedOffset);
      console.log(`[handleAudioProxy proxyRes end] isByteZeroRequest=${isByteZeroRequest} effectiveTotal=${effectiveTotal} bytesStreamed=${bytesStreamed} totalOffset=${totalStreamedOffset} wantsMoreBytes=${wantsMoreBytes} effectiveTargetId=${effectiveTargetId}`);
      if (wantsMoreBytes && effectiveTotal && totalStreamedOffset < effectiveTotal && effectiveTargetId && !res.writableEnded) {
        try {
          let fullUrl = streamCache.get(effectiveTargetId)?.fullUrl;
          if (!fullUrl) {
            console.log(`[handleAudioProxy] Awaiting fullUrl for ${effectiveTargetId}...`);
            const fullPromise = inflightFullResolutions.get(effectiveTargetId) || resolveFullStreamViaYtDlp(effectiveTargetId);
            const fullDetails = await fullPromise;
            fullUrl = fullDetails?.url;
            console.log(`[handleAudioProxy] Resolved fullUrl for ${effectiveTargetId}: ${fullUrl ? 'YES' : 'NO'}`);
          }
          if (fullUrl && !res.writableEnded) {
            return pumpRemainderFromUrl(req, res, fullUrl, totalStreamedOffset, effectiveTotal);
          }
        } catch (tier2Err) {
          console.log(`[handleAudioProxy] Tier 2 resolution error:`, tier2Err.message);
        }
      }
      if (!res.writableEnded) res.end();
    });
    proxyRes.on('error', () => {
      try { res.destroy(); } catch (e) {}
    });
  });

  const abortProxy = () => {
    try { proxyReq.destroy(); } catch (_) {}
  };
  req.on('close', abortProxy);
  res.on('close', abortProxy);

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy(new Error('Proxy request timed out'));
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
      res.end('Proxy error: ' + err.message);
    }
  });

  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

const PORT = process.env.PORT || 3850;
const PUBLIC_DIR = __dirname;
const DATA_DIR = path.join(PUBLIC_DIR, 'data');
const LINKS_FILE = path.join(DATA_DIR, 'links.json');

const linksStore = new Map();
const trackToCode = new Map();
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function getTrackKey(t) {
  if (!t) return '';
  const id = t.id || extractYouTubeId(t.url) || '';
  const n = (t.n || t.title || '').trim().toLowerCase();
  const a = (t.a || t.artist || '').trim().toLowerCase();
  return `${id}|${n}|${a}`;
}

function initLinksStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(LINKS_FILE)) {
      const raw = fs.readFileSync(LINKS_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && item.code && item.track) {
            linksStore.set(item.code, item.track);
            const key = getTrackKey(item.track);
            if (key) trackToCode.set(key, item.code);
          }
        }
      }
    }
  } catch (e) {
    console.error('Failed to load links store:', e);
  }
}

function saveLinksStore() {
  try {
    const list = [];
    for (const [code, track] of linksStore.entries()) {
      list.push({ code, track });
    }
    fs.writeFileSync(LINKS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save links store:', e);
  }
}

function generate7CharCode() {
  let code = '';
  const bytes = crypto.randomBytes(7);
  for (let i = 0; i < 7; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  if (linksStore.has(code)) return generate7CharCode();
  return code;
}

initLinksStore();

const I18N_DIR = path.join(DATA_DIR, 'i18n');
try { if (!fs.existsSync(I18N_DIR)) fs.mkdirSync(I18N_DIR, { recursive: true }); } catch (_) {}

const i18nMemory = new Map();

function callTranslate(text, to) {
  return new Promise((resolve) => {
    if (!text || !text.trim() || to === 'en') return resolve(text ? text.split('\n') : []);
    const clients = ['dict-chrome-ex', 'gtx'];
    let idx = 0;
    function tryNext() {
      if (idx >= clients.length) return resolve(null);
      const c = clients[idx++];
      const u = `https://translate.googleapis.com/translate_a/single?client=${c}&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
      const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
        let b = '';
        res.on('data', chunk => b += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) return tryNext();
          try {
            const data = JSON.parse(b);
            if (data && Array.isArray(data[0])) {
              const joined = data[0].map(s => s[0]).join('').split('\n');
              return resolve(joined);
            }
          } catch (e) {}
          tryNext();
        });
      });
      req.on('error', tryNext);
      req.on('timeout', () => { req.destroy(); tryNext(); });
    }
    tryNext();
  });
}

async function handleI18nBatch(texts, targetLang) {
  const lang = (targetLang || 'en').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!i18nMemory.has(lang)) {
    i18nMemory.set(lang, new Map());
    const langFile = path.join(I18N_DIR, `${lang}.json`);
    if (fs.existsSync(langFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(langFile, 'utf8'));
        for (const [k, v] of Object.entries(parsed)) {
          i18nMemory.get(lang).set(k, v);
        }
      } catch (_) {}
    }
  }

  const dict = i18nMemory.get(lang);
  if (lang === 'en') {
    return texts;
  }

  const missing = [];
  for (const s of texts) {
    if (typeof s === 'string' && s.trim() && !dict.has(s) && !missing.includes(s)) {
      missing.push(s);
    }
  }

  if (missing.length > 0) {
    const chunks = [];
    let curChunk = [];
    let curLen = 0;
    for (const item of missing) {
      if (curChunk.length > 0 && curLen + item.length + 1 > 1500) {
        chunks.push(curChunk);
        curChunk = [];
        curLen = 0;
      }
      curChunk.push(item);
      curLen += item.length + 1;
    }
    if (curChunk.length > 0) chunks.push(curChunk);

    for (const chunk of chunks) {
      const joined = chunk.join('\n');
      const translated = await callTranslate(joined, lang);
      if (translated && translated.length === chunk.length) {
        for (let i = 0; i < chunk.length; i++) {
          dict.set(chunk[i], translated[i]);
        }
      } else {
        for (const item of chunk) {
          const single = await callTranslate(item, lang);
          if (single && single[0]) {
            dict.set(item, single[0]);
          }
        }
      }
    }

    try {
      const obj = {};
      for (const [k, v] of dict.entries()) obj[k] = v;
      fs.writeFile(path.join(I18N_DIR, `${lang}.json`), JSON.stringify(obj, null, 2), () => {});
    } catch (_) {}
  }

  return texts.map(s => dict.get(s) || s);
}

function parseYtmDuration(s) {
  if (!s || typeof s !== 'string') return 0;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function parseYtmViewsOrPlays(text) {
  if (!text || typeof text !== 'string') return 0;
  const t = text.toLowerCase().replace(/\u00a0/g, ' ').replace(/(?:dinlenme|görüntüleme|plays|views)/g, '').trim();
  const m = t.match(/([\d\.,]+)\s*([a-zğüşöçı]*)/);
  if (!m) return 0;
  let raw = m[1];
  if (raw.includes('.') && raw.includes(',')) {
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else {
    raw = raw.replace(',', '.');
  }
  const val = parseFloat(raw);
  if (isNaN(val)) return 0;
  const unit = m[2] || '';
  if (unit.includes('mr') || unit.includes('mlr')) return Math.round(val * 1000000000);
  if (unit.includes('mn') || unit.includes('m')) return Math.round(val * 1000000);
  if (unit.includes('b') || unit.includes('k')) return Math.round(val * 1000);
  return Math.round(val);
}

function parseYtmSongs(json) {
  const out = [];
  const seenIds = new Set();
  const tabs = (json && json.contents && json.contents.tabbedSearchResultsRenderer && json.contents.tabbedSearchResultsRenderer.tabs) || [];
  const sections = (tabs[0] && tabs[0].tabRenderer && tabs[0].tabRenderer.content && tabs[0].tabRenderer.content.sectionListRenderer && tabs[0].tabRenderer.content.sectionListRenderer.contents) || [];

  // Phase 1: Parse MusicCardShelfRenderer (Top Hit / Top Result)
  for (const section of sections) {
    if (section && section.musicCardShelfRenderer) {
      const card = section.musicCardShelfRenderer;
      const title = (card.title && card.title.runs && card.title.runs.map(x => x.text).join('').trim()) || '';
      let videoId = card.onTap && card.onTap.watchEndpoint && card.onTap.watchEndpoint.videoId;
      if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
        if (Array.isArray(card.buttons)) {
          for (const b of card.buttons) {
            const cmd = b && b.buttonRenderer && b.buttonRenderer.command;
            const bVid = cmd && cmd.watchEndpoint && cmd.watchEndpoint.videoId;
            if (bVid && /^[\w-]{11}$/.test(bVid)) {
              videoId = bVid;
              break;
            }
          }
        }
      }

      if (videoId && /^[\w-]{11}$/.test(videoId) && title) {
        const subRuns = (card.subtitle && card.subtitle.runs) || [];
        const segments = [];
        let cur = [];
        for (const run of subRuns) {
          if (run.text === ' • ') {
            segments.push(cur.join('').trim());
            cur = [];
          } else {
            cur.push(run.text);
          }
        }
        segments.push(cur.join('').trim());
        const clean = segments.filter(s => s && !/^(song|şarkı|video)$/i.test(s));

        let duration = 0;
        let artist = 'Unknown Artist';
        for (const seg of clean) {
          if (parseYtmDuration(seg)) {
            duration = parseYtmDuration(seg);
          } else if (artist === 'Unknown Artist' && !/(?:görüntüleme|dinlenme|views|plays)/i.test(seg)) {
            artist = seg;
          }
        }

        const thumbs = (card.thumbnail && card.thumbnail.musicThumbnailRenderer && card.thumbnail.musicThumbnailRenderer.thumbnail && card.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || [];
        let thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        thumbnail = thumbnail.replace(/=w\d+-h\d+[^&]*$/, '=w544-h544');

        out.push({
          id: videoId,
          title,
          artist: artist.replace(/\s*-\s*Topic$/i, '').trim(),
          album: '',
          duration: duration || 180,
          thumbnail,
          url: `https://www.youtube.com/watch?v=${videoId}`
        });
        seenIds.add(videoId);
      }
    }
  }

  // Phase 2: Parse standard list items (shelves and item sections)
  for (const section of sections) {
    const items = [];
    let shelfArtistFallback = '';
    if (section && section.musicCardShelfRenderer) {
      shelfArtistFallback = (section.musicCardShelfRenderer.title && section.musicCardShelfRenderer.title.runs && section.musicCardShelfRenderer.title.runs.map(x => x.text).join('').trim()) || '';
      if (Array.isArray(section.musicCardShelfRenderer.contents)) {
        items.push(...section.musicCardShelfRenderer.contents);
      }
    }
    if (section && section.musicShelfRenderer && Array.isArray(section.musicShelfRenderer.contents)) {
      items.push(...section.musicShelfRenderer.contents);
    }
    if (section && section.itemSectionRenderer && Array.isArray(section.itemSectionRenderer.contents)) {
      items.push(...section.itemSectionRenderer.contents);
    }

    for (const wrap of items) {
      const r = wrap && wrap.musicResponsiveListItemRenderer;
      if (!r) continue;
      const cols = r.flexColumns || [];
      const runsOf = (i) => (cols[i] && cols[i].musicResponsiveListItemFlexColumnRenderer && cols[i].musicResponsiveListItemFlexColumnRenderer.text && cols[i].musicResponsiveListItemFlexColumnRenderer.text.runs) || [];

      const col1Text = runsOf(1).map(x => x.text).join('').trim();
      // Filter out non-song items: podcast episodes, channels, subscriber counts, monthly listeners
      if (/(?:bölüm|episode|podcast|abone|subscriber|aylık kitle|monthly audience)/i.test(col1Text)) {
        continue;
      }

      const overlay = r.overlay && r.overlay.musicItemThumbnailOverlayRenderer && r.overlay.musicItemThumbnailOverlayRenderer.content && r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
      const videoId = (r.playlistItemData && r.playlistItemData.videoId) || (overlay && overlay.playNavigationEndpoint && overlay.playNavigationEndpoint.watchEndpoint && overlay.playNavigationEndpoint.watchEndpoint.videoId);
      if (!videoId || !/^[\w-]{11}$/.test(videoId)) continue;
      if (seenIds.has(videoId)) continue;

      const title = runsOf(0).map((x) => x.text).join('').trim();
      const segments = [];
      let cur = [];
      for (const run of runsOf(1)) {
        if (run.text === ' • ') { segments.push(cur.join('').trim()); cur = []; } else cur.push(run.text);
      }
      segments.push(cur.join('').trim());
      const clean = segments.filter((s) => s && !/^(song|şarkı|video)$/i.test(s));

      let duration = 0;
      if (clean.length && parseYtmDuration(clean[clean.length - 1])) {
        duration = parseYtmDuration(clean.pop());
      }
      let artist = (clean[0] || shelfArtistFallback || 'Unknown Artist').replace(/\s*-\s*Topic$/i, '').trim();
      const album = clean[1] || '';

      const thumbs = (r.thumbnail && r.thumbnail.musicThumbnailRenderer && r.thumbnail.musicThumbnailRenderer.thumbnail && r.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || [];
      let thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      thumbnail = thumbnail.replace(/=w\d+-h\d+[^&]*$/, '=w544-h544');

      if (!title) continue;
      out.push({
        id: videoId,
        title,
        artist: artist || 'Unknown Artist',
        album,
        duration: duration || 180,
        thumbnail,
        url: `https://www.youtube.com/watch?v=${videoId}`
      });
      seenIds.add(videoId);
    }
  }
  return out;
}

function searchYouTubeMusic(query, retryWithoutParams = true) {
  return new Promise((resolve, reject) => {
    const postPayload = (withParams) => {
      const payloadObj = {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240424.01.00',
            hl: 'tr',
            gl: 'TR'
          }
        },
        query: query
      };
      if (withParams) {
        // Param for songs filter with top hit precision
        payloadObj.params = 'Eg-KAQwIABAAGAAgACgB';
      }
      return JSON.stringify(payloadObj);
    };

    const runSearch = (withParams) => {
      const reqBody = postPayload(withParams);
      const req = https.request({
        hostname: 'music.youtube.com',
        path: '/youtubei/v1/search',
        method: 'POST',
        agent: keepAliveHttpsAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reqBody),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 8000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const songs = parseYtmSongs(json);
            if (Array.isArray(songs) && songs.length > 0 && songs[0].id) {
              const norm = normalizeTrackKey(query);
              if (norm) {
                idMapCache.set(norm, songs[0].id);
                saveIdCacheToDisk();
              }
              return resolve(songs);
            }
            if (withParams && retryWithoutParams) {
              return runSearch(false);
            }
            resolve(songs || []);
          } catch (e) {
            if (withParams && retryWithoutParams) {
              return runSearch(false);
            }
            reject(e);
          }
        });
      });

      req.on('error', (err) => {
        if (withParams && retryWithoutParams) {
          return runSearch(false);
        }
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        if (withParams && retryWithoutParams) {
          return runSearch(false);
        }
        reject(new Error('Timeout'));
      });
      req.write(reqBody);
      req.end();
    };

    // First attempt with default search to reliably capture Top Result Hit Card, falling back if empty
    runSearch(false);
  });
}

function searchYouTubeInnertubeWeb(query) {
  return new Promise((resolve) => {
    if (!query || typeof query !== 'string') return resolve([]);
    const cleanQuery = query.trim();
    const payload = JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240424.01.00',
          hl: 'en',
          gl: 'US'
        }
      },
      query: cleanQuery
    });

    const req = https.request('https://www.youtube.com/youtubei/v1/search', {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const matches = [...data.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]);
          const uniqueIds = [...new Set(matches)];
          if (uniqueIds.length > 0) {
            const norm = normalizeTrackKey(cleanQuery);
            if (norm) {
              idMapCache.set(norm, uniqueIds[0]);
              saveIdCacheToDisk();
            }
            return resolve(uniqueIds.map(id => ({ id, url: `https://www.youtube.com/watch?v=${id}` })));
          }
        } catch (_) {}
        resolve([]);
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.write(payload);
    req.end();
  });
}

function extractYouTubeId(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    if (!/^(cand_|dz_|it_|sp_|ym_)/i.test(trimmed)) return trimmed;
    return null;
  }
  const regExp = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts|live)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i;
  const match = trimmed.match(regExp);
  if (match && match[1] && !/^(cand_|dz_|it_|sp_|ym_)/i.test(match[1])) {
    return match[1];
  }
  return null;
}

function fetchYouTubeOEmbed(videoId) {
  return new Promise((resolve) => {
    https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let title = 'YouTube Track';
        let artist = 'YouTube Artist';
        let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            if (json.title) title = json.title.trim();
            if (json.author_name) artist = json.author_name.replace(/\s*-\s*Topic$/i, '').trim();
            if (json.thumbnail_url) thumbnail = json.thumbnail_url;

            if (title.includes(' - ')) {
              const parts = title.split(' - ');
              if (parts.length >= 2) {
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
              }
            }
            title = title.replace(/\s*[\(\[](?:official\s*(?:video|audio|music\s*video)|lyrics|hd|4k)[\)\]]/gi, '').trim();
          } catch (_) {}
        }

        resolve({
          id: videoId,
          title: title || `YouTube Track (${videoId})`,
          artist: artist || 'YouTube',
          album: 'YouTube',
          duration: 180,
          thumbnail,
          url: `https://www.youtube.com/watch?v=${videoId}`
        });
      });
    }).on('error', () => {
      resolve({
        id: videoId,
        title: `YouTube Track (${videoId})`,
        artist: 'YouTube',
        album: 'YouTube',
        duration: 180,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${videoId}`
      });
    });
  });
}

function searchITunes(query) {
  return new Promise((resolve) => {
    https.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=15`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const tracks = (json.results || []).map(t => ({
            id: String(t.trackId),
            title: t.trackName || '',
            artist: t.artistName || '',
            album: t.collectionName || '',
            duration: Math.round((t.trackTimeMillis || 0) / 1000),
            thumbnail: (t.artworkUrl100 || '').replace('100x100', '600x600'),
            streamUrl: t.previewUrl || '',
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent((t.artistName + ' ' + t.trackName).trim())}`
          }));
          resolve(tracks);
        } catch (_) {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

async function searchSoundcloud(query, limit = 14) {
  if (!query) return [];
  // Fast in-process SoundCloud API v2 search (~400ms)
  try {
    const cid = await refreshSoundCloudClientId(false);
    if (cid) {
      const scUrl = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}&client_id=${cid}`;
      const scRes = await fetch(scUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(5000)
      });
      if (scRes.ok) {
        const scData = await scRes.json();
        const items = (scData && Array.isArray(scData.collection)) ? scData.collection : [];
        if (items.length > 0) {
          return items.map(item => ({
            id: String(item.id || Math.random().toString(36).substring(2)),
            title: item.title || 'Untitled',
            artist: (item.user && item.user.username) || item.uploader || 'Unknown Artist',
            duration: Math.round((item.duration || 0) / 1000),
            thumbnail: item.artwork_url || (item.user && item.user.avatar_url) || '',
            url: item.permalink_url || '',
            platform: 'soundcloud'
          }));
        }
      }
    }
  } catch (scErr) {
    console.warn('[searchSoundcloud] Direct API v2 note:', scErr.message);
  }

  return new Promise((resolve) => {
    const args = [
      `scsearch${limit}:${query}`,
      '--dump-single-json',
      '--flat-playlist',
      '--skip-download',
      '--no-warnings',
      '--no-check-certificates'
    ];
    execFile('yt-dlp', args, { timeout: 18000 }, (err, stdout) => {
      if (!err && stdout) {
        try {
          const data = JSON.parse(stdout);
          const entries = (data.entries || []).map((item) => {
            let thumbnail = '';
            if (item.thumbnails && item.thumbnails.length > 0) {
              thumbnail = item.thumbnails[item.thumbnails.length - 1].url;
            } else if (item.thumbnail) {
              thumbnail = item.thumbnail;
            }
            return {
              id: String(item.id || Math.random().toString(36).substring(2)),
              title: item.title || 'Untitled',
              artist: item.uploader || item.channel || item.artist || 'Unknown Artist',
              duration: item.duration || 0,
              thumbnail: thumbnail,
              url: item.webpage_url || item.url || '',
              platform: 'soundcloud'
            };
          });
          if (entries.length > 0) return resolve(entries);
        } catch (_) {}
      }

      // Fallback for local development if yt-dlp is missing: fetch from production VPS search
      try {
        const vpsUrl = `https://app.raserapp.online/api/search?q=${encodeURIComponent(query)}&platform=soundcloud`;
        https.get(vpsUrl, { timeout: 10000, headers: { 'User-Agent': 'RaserLocalDev/1.0' } }, (vpsRes) => {
          let body = '';
          vpsRes.on('data', chunk => body += chunk);
          vpsRes.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              if (parsed && Array.isArray(parsed.tracks) && parsed.tracks.length > 0) {
                return resolve(parsed.tracks);
              }
            } catch (_) {}
            resolve([]);
          });
        }).on('error', () => resolve([]));
      } catch (_) {
        resolve([]);
      }
    });
  });
}

function formatTrack(t) {
  if (!t) return null;
  const d = Math.max(1, parseInt(t.duration, 10) || 180);
  const m = Math.floor(d / 60);
  const s = d % 60;
  return {
    id: t.id,
    title: t.title || 'Unknown Title',
    artist: t.artist || 'Unknown Artist',
    album: t.album || '',
    duration: d,
    durationFormatted: `${m}:${s < 10 ? '0' : ''}${s}`,
    thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.id}/hqdefault.jpg`,
    url: t.url || `https://www.youtube.com/watch?v=${t.id}`,
    platform: t.platform || 'ytmusic',
    isCached: false
  };
}


const lyricsCache = new Map(); // cacheKey -> { data, expireAt }

function cleanTrackTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .replace(/[\(\[\{].*?(?:official|video|music video|mv|lyric|lyrics|audio|remastered|hd|4k|feat|ft|visualizer).*?[\)\]\}]/gi, '')
    .replace(/\s+(?:feat|ft)\.?\s+.*$/gi, '')
    .trim();
}

async function computeSmartIntroOffset(videoId, lrcText) {
  if (!videoId || !/^[\w-]{11}$/.test(videoId) || !lrcText || typeof lrcText !== 'string') {
    return 0;
  }

  try {
    const payload = JSON.stringify({
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '20.10.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          userAgent: 'com.google.ios.youtube/20.10.4',
          osName: 'iOS',
          osVersion: '18.3.2.22D82',
          hl: 'en',
          gl: 'US'
        }
      },
      videoId: videoId
    });

    const playerRes = await new Promise((resolve) => {
      const req = https.request('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'com.google.ios.youtube/20.10.4',
          'X-YouTube-Client-Name': '5',
          'X-YouTube-Client-Version': '20.10.4'
        },
        timeout: 4000
      }, (res) => {
        if (res.statusCode >= 400) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(payload);
      req.end();
    });

    const tracks = playerRes?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0 || !tracks[0].baseUrl) {
      return 0;
    }

    const captionUrl = tracks[0].baseUrl + '&fmt=json3';
    const captionRes = await new Promise((resolve) => {
      const req = https.request(captionUrl, {
        headers: { 'User-Agent': 'com.google.ios.youtube/20.10.4' },
        timeout: 3500
      }, (res) => {
        if (res.statusCode >= 400) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    const events = captionRes?.events;
    if (!Array.isArray(events) || events.length === 0) return 0;

    const captions = [];
    for (const ev of events) {
      if (Array.isArray(ev.segs)) {
        let t = ev.segs.map(s => s.utf8 || '').join('').replace(/\r?\n/g, ' ').replace(/[♪♫\[\]\(\)]/g, '').trim().toLowerCase();
        if (t.length >= 3) {
          captions.push({ text: t, time: (ev.tStartMs || 0) / 1000 });
        }
      }
    }
    if (captions.length === 0) return 0;

    // Extract first candidate lines from LRC
    const lrcLines = [];
    const tagRegex = /\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
    const lines = lrcText.split(/\r?\n/);
    for (const line of lines) {
      tagRegex.lastIndex = 0;
      const m = tagRegex.exec(line);
      if (m) {
        const time = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
        const clean = line.replace(/\[.*?\]/g, '').replace(/<[^>]+>/g, '').replace(/[♪♫\[\]\(\)]/g, '').trim().toLowerCase();
        if (clean.length >= 3 && !/^(instrumental|intro|solo|music|break)$/i.test(clean)) {
          lrcLines.push({ text: clean, time: time });
          if (lrcLines.length >= 8) break;
        }
      }
    }
    if (lrcLines.length === 0) return 0;

    // Match first LRC lines with YouTube caption events
    for (const lrc of lrcLines.slice(0, 5)) {
      const words = lrc.text.match(/\b[a-z0-9]{3,}\b/gi) || [];
      if (words.length === 0) continue;
      for (const cap of captions.slice(0, 20)) {
        const matchedCount = words.filter(w => cap.text.includes(w)).length;
        if (matchedCount >= Math.min(2, words.length)) {
          const diff = cap.time - lrc.time;
          // Only apply if diff is noticeable (>= 0.4s) and reasonable (within +/- 90s)
          if (Math.abs(diff) >= 0.4 && Math.abs(diff) <= 90) {
            return Math.round(diff * 10) / 10;
          }
          return 0;
        }
      }
    }
  } catch (_) {}
  return 0;
}


async function fetchLyricsFromLrclib(title, artist, duration, videoId) {
  const cleanTitle = cleanTrackTitle(title) || title;
  const cacheKey = `${cleanTitle.toLowerCase()}:::${(artist || '').toLowerCase()}:::${videoId || ''}`;
  const now = Date.now();
  if (lyricsCache.has(cacheKey)) {
    const entry = lyricsCache.get(cacheKey);
    if (entry.expireAt > now) {
      return entry.data;
    }
  }

  const userAgent = 'RaserMusicApp/1.1 (https://github.com/tetoverse/Raser)';

  // Helper fetch function
  const fetchJson = (targetUrl) => {
    return new Promise((resolve) => {
      const parsed = new URL(targetUrl);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': userAgent },
        timeout: 4000
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  };

  // 1. Try exact match /api/get
  let getParams = `track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(artist || '')}`;
  if (duration && !isNaN(Number(duration))) {
    getParams += `&duration=${Math.round(Number(duration))}`;
  }
  let result = await fetchJson(`https://lrclib.net/api/get?${getParams}`);

  // 2. If not found, try search
  if (!result || (!result.syncedLyrics && !result.plainLyrics)) {
    const q = `${cleanTitle} ${artist || ''}`.trim();
    const searchRes = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
    if (Array.isArray(searchRes) && searchRes.length > 0) {
      // Prioritize item with syncedLyrics
      result = searchRes.find(it => it.syncedLyrics) || searchRes[0];
    }
  }

  let finalLyrics = '';
  let isSynced = false;
  if (result) {
    if (result.syncedLyrics) {
      finalLyrics = result.syncedLyrics;
      isSynced = true;
    } else if (result.plainLyrics) {
      finalLyrics = result.plainLyrics;
      isSynced = false;
    }
  }

  let introOffset = 0;
  if (finalLyrics && isSynced && videoId) {
    try {
      introOffset = await computeSmartIntroOffset(videoId, finalLyrics);
    } catch (_) {}
  }

  const responseData = {
    success: !!finalLyrics,
    lyrics: finalLyrics || '',
    isSynced: isSynced,
    introOffset: introOffset || 0,
    trackName: result ? result.trackName : cleanTitle,
    artistName: result ? result.artistName : artist
  };

  // Cache for 2 hours if found, 10 minutes if not found
  const ttl = finalLyrics ? (2 * 60 * 60 * 1000) : (10 * 60 * 1000);
  lyricsCache.set(cacheKey, { data: responseData, expireAt: now + ttl });
  return responseData;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Shorten endpoint
  if (pathname === '/api/shorten' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const track = {
          n: (data.n || data.title || '').trim(),
          a: (data.a || data.artist || '').trim(),
          url: (data.url || '').trim(),
          img: (data.img || data.thumbnail || '').trim(),
          dur: parseInt(data.dur || data.duration || '0', 10) || 0,
          t: data.t || 'music',
          stream: (data.stream || data.streamUrl || '').trim()
        };

        if (!track.n && !track.a && !track.url && !track.stream) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid track data' }));
          return;
        }

        const trackKey = getTrackKey(track);
        let code = trackKey ? trackToCode.get(trackKey) : null;
        if (!code) {
          code = generate7CharCode();
          linksStore.set(code, track);
          if (trackKey) trackToCode.set(trackKey, code);
          saveLinksStore();
        }

        let host = req.headers['x-forwarded-host'] || req.headers.host || 'raserapp.online';
        if (host.startsWith('app.')) host = host.slice(4);
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const shortUrl = `${proto}://${host}/s/${code}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, code, url: shortUrl }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Get Track by Code
  const apiLinkMatch = pathname.match(/^\/api\/link\/([a-zA-Z0-9]{7})\/?$/);
  if (apiLinkMatch) {
    const code = apiLinkMatch[1];
    const track = linksStore.get(code);
    if (track) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, code, track }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Link not found' }));
    }
    return;
  }

  // Short URL direct visit: /s/:code (7 characters)
  const shortMatch = pathname.match(/^\/s\/([a-zA-Z0-9]{7})\/?$/);
  if (shortMatch) {
    const code = shortMatch[1];
    const track = linksStore.get(code);
    if (track) {
      const filePath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Server Error');
          return;
        }
        const injection = `<script>window.__PRELOADED_TRACK__ = ${JSON.stringify(track)};</script>`;
        const modifiedHtml = html.replace('<head>', `<head>\n  ${injection}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
        res.end(modifiedHtml);
      });
      return;
    } else {
      res.writeHead(302, { Location: '/search' });
      res.end();
      return;
    }
  }

  // API Search endpoint
  if (pathname === '/api/search') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const q = (reqUrl.searchParams.get('q') || '').trim();
    const platform = (reqUrl.searchParams.get('platform') || 'ytmusic').toLowerCase();

    // Direct YouTube link / video ID detection
    let directYtId = extractYouTubeId(q);
    if (!directYtId && reqUrl.searchParams.get('v')) {
      directYtId = extractYouTubeId(reqUrl.searchParams.get('v'));
    }
    if (!directYtId && reqUrl.search) {
      directYtId = extractYouTubeId(reqUrl.search);
    }

    if (directYtId) {
      try {
        const ytTrack = await fetchYouTubeOEmbed(directYtId);
        if (ytTrack) {
          const formatted = [formatTrack(ytTrack)].filter(Boolean);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, tracks: formatted, results: formatted, hasMore: false }));
          return;
        }
      } catch (_) {}
    }

    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks: [], results: [], hasMore: false }));
      return;
    }

    if (platform === 'soundcloud') {
      try {
        const scResults = await searchSoundcloud(q, 14);
        const formatted = (scResults || []).map(formatTrack).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tracks: formatted, results: formatted, hasMore: false }));
        return;
      } catch (_) {}
    }

    const prewarmSearchTracks = (tracks) => {
      if (!Array.isArray(tracks) || tracks.length === 0) return;
      setImmediate(() => {
        for (const tr of tracks.slice(0, 2)) {
          const tid = tr && typeof tr.id === 'string' ? tr.id.trim() : '';
          if (!/^[\w-]{11}$/.test(tid)) continue;
          const cached = streamCache.get(tid);
          if (cached && cached.fullUrl && cached.expireAt > Date.now()) continue;
          resolveAudioStreamDetails(tid, 'youtube', '', false, '', 0).catch(() => {});
        }
      });
    };

    try {
      let results = await searchYouTubeMusic(q);
      if (!results || results.length === 0) {
        results = await searchITunes(q);
      }
      const formatted = (results || []).map(formatTrack).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks: formatted, results: formatted, hasMore: false }));
      prewarmSearchTracks(formatted);
    } catch (err) {
      const fallback = await searchITunes(q);
      const formatted = (fallback || []).map(formatTrack).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks: formatted, results: formatted, hasMore: false }));
    }
    return;
  }

  // Trending tracks endpoint: /api/trending
  if (pathname === '/api/trending' || pathname === '/api/hot') {
    try {
      let results = await searchYouTubeMusic('top hits 2026');
      if (!results || results.length === 0) results = await searchITunes('top hits 2026');
      const formatted = (results || []).map(formatTrack).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks: formatted, hasMore: false }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tracks: [], hasMore: false }));
    }
    return;
  }

  // Artist & Vibe endpoints
  if (pathname === '/api/artist') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, tracks: [], albums: [], topTracks: [] }));
    return;
  }
  if (pathname === '/api/vibe') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch (_) {}

        // Gather all queries from artists and seeds
        let queries = [];
        if (Array.isArray(payload.artists) && payload.artists.length > 0) {
          queries.push(...payload.artists.map(a => String(a || '').trim()).filter(Boolean));
        }
        if (Array.isArray(payload.seeds)) {
          for (const s of payload.seeds) {
            if (typeof s === 'string' && s.trim()) {
              queries.push(s.trim());
            } else if (s && typeof s === 'object') {
              if (s.artist && s.title) queries.push(`${s.artist} ${s.title}`);
              else if (s.artist) queries.push(s.artist);
              else if (s.title) queries.push(s.title);
            }
          }
        }
        queries = [...new Set(queries.filter(Boolean))];

        const primaryQuery = queries[0] || 'chill pop hits';
        const secondaryQuery = queries[1] || queries[2] || null;

        let results = await searchYouTubeMusic(primaryQuery);
        if (secondaryQuery && (!results || results.length < 8)) {
          try {
            const extra = await searchYouTubeMusic(secondaryQuery);
            if (extra && extra.length > 0) {
              results = [...(results || []), ...extra];
            }
          } catch (_) {}
        }
        if (!results || results.length === 0) {
          try {
            results = await searchITunes(primaryQuery);
          } catch (_) {}
        }
        if (!results || results.length === 0) {
          results = await searchYouTubeMusic('top hits 2026');
        }

        const formatted = (results || []).map(formatTrack).filter(Boolean);
        // Deduplicate tracks
        const seen = new Set();
        const unique = [];
        for (const t of formatted) {
          const key = (t.id || t.title || '').toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(t);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tracks: unique }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tracks: [] }));
      }
    });
    return;
  }

  // Audio streaming proxy endpoint
  if (pathname === '/api/audio-proxy') {
    const targetUrl = reqUrl.searchParams.get('url') || '';
    return handleAudioProxy(req, res, targetUrl);
  }

  // Direct Audio Streaming endpoint: GET /api/stream?id=...&title=...&artist=...
  if (pathname === '/api/stream') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    const reqUrlParam = (reqUrl.searchParams.get('url') || '').trim();
    const reqIdParam = (reqUrl.searchParams.get('id') || '').trim();
    const platform = (reqUrl.searchParams.get('platform') || '').trim().toLowerCase();
    const title = (reqUrl.searchParams.get('title') || '').trim();
    const artist = (reqUrl.searchParams.get('artist') || '').trim();
    const quality = (reqUrl.searchParams.get('quality') || '').trim().toLowerCase();
    const refresh = reqUrl.searchParams.get('refresh') === '1' || reqUrl.searchParams.get('forceYtDlp') === '1';
    const queryFallback = (reqUrl.searchParams.get('q') || '').trim() || (artist && title ? `${artist} - ${title}` : title);

    const isSoundcloud = platform === 'soundcloud' || reqUrlParam.includes('soundcloud.com') || (!extractYouTubeId(reqIdParam) && /^\d{6,}$/.test(reqIdParam));

    let target = reqIdParam || extractYouTubeId(reqUrlParam) || reqUrlParam;
    if (!target && queryFallback) {
      target = queryFallback;
    }

    if (!target) {
      if (reqUrl.searchParams.get('format') === 'json') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Missing track id or url' }));
      }
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Missing track id or url');
    }

    try {
      const rangeHeader = req.headers['range'] || '';
      let rangeStart = 0;
      const rangeMatch = rangeHeader.match(/bytes=(\d+)-/);
      if (rangeMatch) {
        rangeStart = parseInt(rangeMatch[1], 10);
      }

      const effectivePlatform = isSoundcloud ? 'soundcloud' : (platform || 'youtube');
      const streamDetails = await resolveAudioStreamDetails(target, effectivePlatform, queryFallback, refresh, quality, rangeStart);
      const rawStreamUrl = streamDetails.url;
      const isHls = rawStreamUrl.includes('.m3u8') || rawStreamUrl.includes('/hls') || rawStreamUrl.includes('cf-hls-media') || rawStreamUrl.includes('playback.media-streaming');

      // Backward compatibility: format=json query parameter returns JSON
      if (reqUrl.searchParams.get('format') === 'json') {
        const reqHost = req.headers['x-forwarded-host'] || req.headers.host || 'app.raserapp.online';
        const reqProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
        const serverOrigin = `${reqProto}://${reqHost}`;
        const proxiedUrl = `${serverOrigin}/api/audio-proxy?url=${encodeURIComponent(rawStreamUrl)}`;
        const streamUrl = isHls ? rawStreamUrl : proxiedUrl;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          streamUrl,
          proxyUrl: proxiedUrl,
          rawStreamUrl,
          isHls,
          mimeType: streamDetails.mimeType,
          itag: streamDetails.itag,
          resolvedId: streamDetails.resolvedId || null
        }));
      }

      // Direct audio streaming pipeline straight into HTTP response
      const determinedMime = streamDetails.mimeType ? streamDetails.mimeType.split(';')[0].trim() : (streamDetails.itag === 251 ? 'audio/webm' : 'audio/mp4');
      const totalLen = streamDetails.contentLength ? parseInt(streamDetails.contentLength, 10) : null;
      return handleAudioProxy(req, res, rawStreamUrl, 5, {
        isStreamEndpoint: true,
        contentType: determinedMime,
        targetId: streamDetails.resolvedId || target,
        seamlessTotalLength: totalLen
      });
    } catch (err) {
      if (reqUrl.searchParams.get('format') === 'json') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`Failed to stream audio: ${err.message}`);
    }
  }

  // Desktop & Web stream info endpoint: /api/stream-info?id=...&url=...
  if (pathname === '/api/stream-info') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host || 'app.raserapp.online';
    const reqProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const serverOrigin = `${reqProto}://${reqHost}`;
    const reqUrlParam = (reqUrl.searchParams.get('url') || '').trim();
    const reqIdParam = (reqUrl.searchParams.get('id') || '').trim();
    const platform = (reqUrl.searchParams.get('platform') || '').trim().toLowerCase();
    const title = (reqUrl.searchParams.get('title') || '').trim();
    const artist = (reqUrl.searchParams.get('artist') || '').trim();
    const queryFallback = (reqUrl.searchParams.get('q') || '').trim() || (artist && title ? `${artist} - ${title}` : title);

    const isSoundcloud = platform === 'soundcloud' || reqUrlParam.includes('soundcloud.com') || (!extractYouTubeId(reqIdParam) && /^\d{6,}$/.test(reqIdParam));

    if (isSoundcloud) {
      try {
        const targetSc = reqIdParam || reqUrlParam;
        const streamUrl = await fetchDirectSoundCloudStream(targetSc, queryFallback);
        if (streamUrl) {
          const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('/hls') || streamUrl.includes('cf-hls-media') || streamUrl.includes('playback.media-streaming');
          const proxiedUrl = `${serverOrigin}/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            streamUrl: isHls ? streamUrl : proxiedUrl,
            proxyUrl: proxiedUrl,
            rawStreamUrl: streamUrl,
            isHls: isHls,
            isLocal: false
          }));
        }
      } catch (scErr) {
        console.warn('[SoundCloud Resolver] Direct SC resolution note:', scErr.message);
      }
    }

    const ytId = extractYouTubeId(reqIdParam) || extractYouTubeId(reqUrlParam) || (/^[a-zA-Z0-9_-]{11}$/.test(reqIdParam) ? reqIdParam : '');
    const target = ytId || (reqUrlParam.startsWith('http') ? reqUrlParam : null) || (reqIdParam.startsWith('http') ? reqIdParam : null) || (queryFallback ? `ytsearch1:${queryFallback}` : null);

    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing track id or url' }));
      return;
    }

    try {
      const refresh = reqUrl.searchParams.get('refresh') === '1' || reqUrl.searchParams.get('forceYtDlp') === '1';
      const forceYtDlp = reqUrl.searchParams.get('forceYtDlp') === '1';
      const effectivePlatform = isSoundcloud ? 'youtube' : platform;
      const rangeStart = forceYtDlp ? 1048576 : 0;
      const streamDetails = await resolveAudioStreamDetails(target, effectivePlatform, queryFallback, refresh, '', rangeStart);
      const rawStreamUrl = streamDetails.url;
      const isHls = rawStreamUrl.includes('.m3u8');
      const proxiedUrl = `${serverOrigin}/api/audio-proxy?url=${encodeURIComponent(rawStreamUrl)}`;
      const streamUrl = isHls ? rawStreamUrl : proxiedUrl;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        streamUrl: streamUrl,
        proxyUrl: proxiedUrl,
        rawStreamUrl: rawStreamUrl,
        isHls: isHls,
        isLocal: false,
        resolvedId: streamDetails.resolvedId || null
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // Pre-resolve YouTube Video IDs in batch: POST /api/resolve-ids or GET /api/resolve-ids?q=...
  if (pathname === '/api/resolve-ids') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const handleBatchResolve = async (tracks) => {
      if (!Array.isArray(tracks) || tracks.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, resolved: {} }));
      }

      const slice = tracks.slice(0, 30);
      const resolved = {};
      const toSearch = [];

      for (const t of slice) {
        if (!t) continue;
        const id = String(t.id || '').trim();
        const artist = String(t.artist || '').trim();
        const title = String(t.title || '').trim();
        const is11 = /^[a-zA-Z0-9_-]{11}$/.test(id) && !/^(cand_|dz_|it_|sp_|ym_)/i.test(id);

        if (is11) {
          resolved[id] = id;
          continue;
        }

        const norm = normalizeTrackKey(artist ? `${artist} - ${title}` : title);
        if (id && idMapCache.has(id)) {
          resolved[id] = idMapCache.get(id);
        } else if (norm && idMapCache.has(norm)) {
          resolved[id || norm] = idMapCache.get(norm);
        } else if (title || artist) {
          toSearch.push({ origId: id || norm, query: artist ? `${artist} ${title}` : title, norm });
        }
      }

      if (toSearch.length > 0) {
        const concurrency = 6;
        for (let i = 0; i < toSearch.length; i += concurrency) {
          const chunk = toSearch.slice(i, i + concurrency);
          await Promise.all(chunk.map(async (item) => {
            try {
              const resSongs = await searchYouTubeMusic(item.query);
              if (Array.isArray(resSongs) && resSongs.length > 0 && resSongs[0].id) {
                const vid = resSongs[0].id;
                resolved[item.origId] = vid;
                if (item.norm) idMapCache.set(item.norm, vid);
                if (item.origId) idMapCache.set(item.origId, vid);
              }
            } catch (_) {}
          }));
        }
        saveIdCacheToDisk();
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, resolved }));
    };

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          handleBatchResolve(parsed.tracks || []);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      });
      return;
    } else {
      const q = reqUrl.searchParams.get('q') || '';
      const id = reqUrl.searchParams.get('id') || '';
      const title = reqUrl.searchParams.get('title') || '';
      const artist = reqUrl.searchParams.get('artist') || '';
      handleBatchResolve([{ id, title: title || q, artist }]);
      return;
    }
  }

  // Desktop helper endpoints
  if (pathname === '/api/i18n-batch' || pathname === '/api/translate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const target = payload.target || payload.targetLang || payload.to || 'en';
        const texts = Array.isArray(payload.texts) ? payload.texts : (payload.text ? [payload.text] : []);
        const results = await handleI18nBatch(texts, target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, translations: results }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, translations: [] }));
      }
    });
    return;
  }
  if (pathname === '/api/state' || pathname.startsWith('/api/lastfm')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (pathname === '/api/track-cover') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, cover: '' }));
    return;
  }

  if (pathname === '/api/lyrics' || pathname === '/api/lyrics-words') {
    const title = (reqUrl.searchParams.get('title') || '').trim();
    const artist = (reqUrl.searchParams.get('artist') || '').trim();
    const duration = reqUrl.searchParams.get('duration');
    const videoId = (reqUrl.searchParams.get('id') || reqUrl.searchParams.get('videoId') || '').trim();

    if (!title) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, lyrics: '' }));
      return;
    }

    try {
      const lyricsData = await trace(fetchLyricsFromLrclib(title, artist, duration, videoId), { label: 'fetchLyricsFromLrclib', timeoutMs: 6000 });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      });
      res.end(JSON.stringify(lyricsData));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, lyrics: '' }));
    }
    return;
  }

  // Desktop Version Check & Mandatory Auto-Update
  if (pathname === '/api/desktop-version') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    return res.end(JSON.stringify({
      version: '1.1.2',
      min_version: '1.1.2',
      mandatory: true,
      download_url: 'https://github.com/tetoverse/Raser/releases/latest/download/Raser_1.1.1_x64-setup.exe',
      notes: 'Raser v1.1.1 - Pure Rust Native Audio Core, ultra-düşük RAM optimizasyonu ve Windows Taskbar kontrolleri.',
      pub_date: new Date().toISOString()
    }));
  }

  // Cloud Desktop Auth Relay (Session Ticket exchange for Tauri / Desktop)
  if (!global.__cloudAuthSessions) {
    global.__cloudAuthSessions = new Map();
  }

  if (pathname === '/api/desktop-auth-session') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const sessionId = payload.sessionId;
          const authData = payload.auth;
          if (sessionId && authData) {
            global.__cloudAuthSessions.set(sessionId, { auth: authData, createdAt: Date.now() });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
          }
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing sessionId or auth' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'GET') {
      const sessionId = reqUrl.searchParams.get('sessionId') || '';
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ready: false, error: 'Missing sessionId' }));
      }
      const entry = global.__cloudAuthSessions.get(sessionId);
      if (entry && (Date.now() - entry.createdAt < 300000)) { // 5 min expiry
        global.__cloudAuthSessions.delete(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ready: true, auth: entry.auth }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ready: false }));
    }
  }

  // Desktop Google Auth Bridge
  if (pathname === '/auth-desktop' || pathname === '/auth-desktop.html') {
    const filePath = path.join(PUBLIC_DIR, 'auth-desktop.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Auth bridge page not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    return;
  }

  // Search page
  if (pathname === '/search' || pathname === '/search/' || pathname === '/search/index.html') {
    const filePath = path.join(PUBLIC_DIR, 'search.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Search page not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const referer = (req.headers.referer || '').toLowerCase();
  const isApp = host.startsWith('app.') || pathname.startsWith('/app') || reqUrl.searchParams.get('app') === '1' || referer.includes('/app') || referer.includes('app=1') || req.headers['x-is-app'] === '1';

  // Main page / player / web player
  if (pathname === '/' || pathname === '/index.html' || pathname === '/app' || pathname === '/app/') {
    // If accessing via app subdomain or /app, serve the 1:1 Desktop Web Player!
    const targetFile = isApp ? path.join(PUBLIC_DIR, 'desktop-web', 'index.html') : path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(targetFile, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // If in app context and file exists in desktop-web, serve it
  if (isApp) {
    const cleanPath = pathname.replace(/^\/app(\/|$)/, '/');
    const desktopPath = path.normalize(path.join(PUBLIC_DIR, 'desktop-web', cleanPath)).replace(/^(\.\.[\/\\])+/, '');
    if (desktopPath.startsWith(path.join(PUBLIC_DIR, 'desktop-web')) && fs.existsSync(desktopPath) && fs.statSync(desktopPath).isFile()) {
      const ext = path.extname(desktopPath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=UTF-8',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.json': 'application/json'
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': (ext === '.js' || ext === '.css' || ext === '.html') ? 'no-cache, must-revalidate' : 'public, max-age=86400'
      });
      fs.createReadStream(desktopPath).pipe(res);
      return;
    }
  }

  // Static files fallback
  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath.startsWith(PUBLIC_DIR) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    const ext = path.extname(safePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=UTF-8',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.json': 'application/json'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(safePath).pipe(res);
    return;
  }

  // Fallback to index.html
  const fallbackFile = isApp ? path.join(PUBLIC_DIR, 'desktop-web', 'index.html') : path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(fallbackFile, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RaserWeb server running at http://0.0.0.0:${PORT}`);
  });
}

module.exports = {
  server,
  resolveAudioStream,
  resolveAudioStreamDetails,
  fetchYouTubeInnertubeStream,
  searchYouTubeMusic,
  handleAudioProxy
};
