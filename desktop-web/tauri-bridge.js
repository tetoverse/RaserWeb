// Raser Native - Tauri v2 IPC Bridge
(function initTauriBridge() {
  const invoke = (cmd, args) => {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.resolve();
  };

  const mediaCommandListeners = [];

  function handleMediaDispatch(cmd) {
    if (!cmd) return;
    mediaCommandListeners.forEach(fn => {
      try { fn(cmd); } catch (_) {}
    });
    if (typeof window.__raserMediaCommand === 'function' && window.__raserMediaCommand !== handleMediaDispatch) {
      try { window.__raserMediaCommand(cmd); } catch (_) {}
    }
  }

  window.__raserMediaDispatch = handleMediaDispatch;
  if (!window.__raserMediaCommand) {
    window.__raserMediaCommand = handleMediaDispatch;
  }

  const setupTauriEventListener = () => {
    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      window.__TAURI__.event.listen('media-command', (e) => {
        handleMediaDispatch(e.payload);
      });
    }
  };
  setupTauriEventListener();
  window.addEventListener('DOMContentLoaded', setupTauriEventListener);

  // Wire up window controls and system features for Tauri
  window.electronAPI = Object.assign(window.electronAPI || {}, {
    isWindows: true,
    isTauri: true,
    platform: 'win32',
    minimizeWindow: () => invoke('minimize_window'),
    maximizeWindow: () => invoke('toggle_maximize_window'),
    closeWindow: () => invoke('close_window'),
    taskbarPlaybackState: (playing) => invoke('taskbar_playback_state', { playing: !!playing }),
    updateTaskbarState: (playing) => invoke('taskbar_playback_state', { playing: !!playing }),
    onMediaCommand: (cb) => {
      if (typeof cb === 'function') mediaCommandListeners.push(cb);
    },
    setMediaKeys: () => {},
    mediaKeysActive: () => {},
    openExternal: (url) => {
      try {
        invoke('open_external', { url });
        return;
      } catch (_) {}
      try {
        if (window.__TAURI__ && window.__TAURI__.opener && typeof window.__TAURI__.opener.openUrl === 'function') {
          return window.__TAURI__.opener.openUrl(url);
        }
      } catch (_) {}
      window.open(url, '_blank');
    },
    getServerPort: async () => 3850,
    getGpuCompositing: async () => 'enabled',
    onWindowVisibility: (cb) => {
      document.addEventListener('visibilitychange', () => cb(!document.hidden));
    },
    setZoomFactor: () => {},
    getZoomFactor: () => 1.0,
    discordRpcUpdate: (track) => invoke('discord_rpc_update', { track }),
    discordRpcClear: () => invoke('discord_rpc_clear'),
    pickLocalFiles: async () => {
      const tracks = await invoke('pick_local_files');
      if (Array.isArray(tracks)) {
        return tracks.map(t => {
          if (t.path && window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.convertFileSrc === 'function') {
            try { t.url = window.__TAURI__.core.convertFileSrc(t.path); } catch (_) {}
          }
          return t;
        });
      }
      return tracks || [];
    },
    pickLocalFolder: async () => {
      const tracks = await invoke('pick_local_folder');
      if (Array.isArray(tracks)) {
        return tracks.map(t => {
          if (t.path && window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.convertFileSrc === 'function') {
            try { t.url = window.__TAURI__.core.convertFileSrc(t.path); } catch (_) {}
          }
          return t;
        });
      }
      return tracks || [];
    },
    rescanLocalMetadata: async () => [],
    storageInitSync: () => {
      if (window.__RASER_INITIAL_STORAGE__ && typeof window.__RASER_INITIAL_STORAGE__ === 'object') {
        return window.__RASER_INITIAL_STORAGE__;
      }
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) out[k] = localStorage.getItem(k);
        }
      } catch (_) {}
      return out;
    },
    storageSaveSync: (data) => {
      invoke('save_disk_storage', { data });
    },
    storageSaveBatch: (data) => {
      invoke('save_disk_storage', { data });
    },
    setThumbarButtons: () => {},
    getCacheSize: async () => 0,
    clearCache: async () => {},

    // Rust Audio Core APIs
    rustAudioLoad: (url, startPos, duration, autoplay, trackId) => invoke('rust_audio_load', {
      url,
      startPos,
      start_pos: startPos,
      duration,
      autoplay,
      trackId: trackId || null,
      track_id: trackId || null
    }),
    rustAudioPlay: () => invoke('rust_audio_play'),
    rustAudioPause: () => invoke('rust_audio_pause'),
    rustAudioToggle: () => invoke('rust_audio_toggle'),
    rustAudioSeek: (position) => invoke('rust_audio_seek', { position }),
    rustAudioSetVolume: (volume) => invoke('rust_audio_set_volume', { volume }),
    rustAudioSetSpeed: (speed) => invoke('rust_audio_set_speed', { speed }),
    rustAudioGetState: () => invoke('rust_audio_get_state'),
    rustAudioGetFrequencyData: () => {
      const now = performance.now();
      if (_isPlaying && !document.hidden && !isFetchingFreq && now - lastFreqFetchMs >= 32) {
        lastFreqFetchMs = now;
        isFetchingFreq = true;
        invoke('rust_audio_get_frequency_data').then(data => {
          if (data && data.length) {
            cachedRustFreqData.set(data.subarray ? data.subarray(0, cachedRustFreqData.length) : data.slice(0, cachedRustFreqData.length));
          }
        }).catch(() => {}).finally(() => {
          isFetchingFreq = false;
        });
      }
      return cachedRustFreqData;
    },
    getCacheLyrics: (trackId) => invoke('get_cache_lyrics', { trackId }),
    saveCacheLyrics: (trackId, lyricsJson) => invoke('save_cache_lyrics', { trackId, lyricsJson }),
    getCacheStats: () => invoke('get_cache_stats'),
    clearDiskCache: () => invoke('clear_disk_cache'),
    openCacheFolder: () => invoke('open_cache_folder')
  });

  // --- Rust Audio Core Hook for HTML5 native-audio ---
  let _isPlaying = false;
  let _currentPosition = 0;
  let _currentDuration = 0;
  let _volume = 0.85;
  let _speed = 1.0;
  let _muted = false;
  let _currentSrc = '';
  let _isLoading = false;
  let _hasEnded = false;
  let currentLoadToken = 0;
  let lastSeekMs = 0;
  let lastSeekTarget = 0;
  let cachedRustFreqData = new Uint8Array(64);
  let isFetchingFreq = false;
  let lastFreqFetchMs = 0;

  const hookNativeAudioElement = (audio) => {
    if (!audio || audio.__rustAudioHooked) return;
    audio.__rustAudioHooked = true;
    window.__rustAudioActive = true;

    try {
      audio.removeAttribute('src');
      audio.src = '';
    } catch (_) {}

    const notifyTrackEnded = () => {
      if (_hasEnded || _isLoading) return;
      _hasEnded = true;
      _isPlaying = false;
      cachedRustFreqData.fill(0);
      audio.dispatchEvent(new Event('pause'));
      audio.dispatchEvent(new Event('ended'));
      invoke('taskbar_playback_state', { playing: false }).catch(() => {});
    };
    window.__raserAudioEnded = notifyTrackEnded;

    if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
      window.__TAURI__.event.listen('rust-audio-ended', () => {
        notifyTrackEnded();
      });
    }

    Object.defineProperty(audio, 'src', {
      configurable: true,
      enumerable: true,
      get: () => _currentSrc,
      set: (url) => {
        const loadToken = ++currentLoadToken;
        _currentSrc = url || '';
        if (!_currentSrc) {
          _isPlaying = false;
          _hasEnded = false;
          _isLoading = false;
          _currentPosition = 0;
          lastDispatchedPos = 0;
          invoke('rust_audio_pause').catch(() => {});
          return;
        }
        _isLoading = true;
        _hasEnded = false;
        _currentPosition = 0;
        lastDispatchedPos = 0;
        cachedRustFreqData.fill(0);
        audio.dispatchEvent(new Event('loadstart'));
        audio.dispatchEvent(new Event('waiting'));

        let streamUrl = _currentSrc;
        if (streamUrl.startsWith('file:///')) {
          try {
            streamUrl = decodeURIComponent(streamUrl.slice(8)).replace(/\//g, '\\');
          } catch (_) {
            streamUrl = streamUrl.slice(8).replace(/\//g, '\\');
          }
        } else if (streamUrl.startsWith('http://asset.localhost/') || streamUrl.startsWith('https://asset.localhost/')) {
          try {
            const pathPart = decodeURIComponent(streamUrl.replace(/^https?:\/\/asset\.localhost\//, ''));
            streamUrl = pathPart.replace(/^\\\\\?\\/, '');
          } catch (_) {}
        }

        let durHint = null;
        let trackId = null;
        try {
          if (typeof state !== 'undefined' && state.currentTrack) {
            if (Number.isFinite(state.currentTrack.duration) && state.currentTrack.duration > 0) {
              durHint = state.currentTrack.duration;
            }
            trackId = (typeof getTrackCanonicalId === 'function' ? getTrackCanonicalId(state.currentTrack) : '') || state.currentTrack.id || state.currentTrack.resolvedId || null;
          }
        } catch (_) {}

        if (!trackId && typeof streamUrl === 'string' && streamUrl.includes('?')) {
          try {
            const parsed = new URL(streamUrl, 'http://localhost');
            trackId = parsed.searchParams.get('id') || parsed.searchParams.get('trackId') || parsed.searchParams.get('v') || null;
          } catch (_) {}
        }

        invoke('rust_audio_load', {
          url: streamUrl,
          startPos: 0,
          start_pos: 0,
          duration: durHint,
          autoplay: _isPlaying,
          trackId: trackId,
          track_id: trackId
        }).then((st) => {
          if (loadToken !== currentLoadToken) return;
          _isLoading = false;
          _currentPosition = (st && typeof st.position === 'number') ? st.position : 0;
          lastDispatchedPos = _currentPosition;
          if (st && typeof st.duration === 'number' && st.duration > 0) {
            _currentDuration = st.duration;
          } else if (durHint && durHint > 0) {
            _currentDuration = durHint;
          }
          audio.dispatchEvent(new Event('loadedmetadata'));
          audio.dispatchEvent(new Event('durationchange'));
          audio.dispatchEvent(new Event('canplay'));
          audio.dispatchEvent(new Event('canplaythrough'));
          if (_isPlaying) {
            invoke('rust_audio_play').catch(() => {});
            audio.dispatchEvent(new Event('playing'));
          }
        }).catch((err) => {
          if (loadToken !== currentLoadToken) return;
          console.warn('[RustAudioCore] load error:', err);
          _isLoading = false;
          audio.dispatchEvent(new Event('error'));
        });
      }
    });

    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      enumerable: true,
      get: () => _currentPosition,
      set: (val) => {
        const target = Math.max(0, Number(val) || 0);
        _currentPosition = target;
        lastDispatchedPos = target;
        lastSeekMs = performance.now();
        lastSeekTarget = target;
        _hasEnded = false;
        invoke('rust_audio_seek', { position: target }).catch(() => {});
        audio.dispatchEvent(new Event('seeked'));
        audio.dispatchEvent(new Event('timeupdate'));
      }
    });

    Object.defineProperty(audio, 'duration', {
      configurable: true,
      enumerable: true,
      get: () => (_currentDuration > 0 ? _currentDuration : NaN)
    });

    Object.defineProperty(audio, 'paused', {
      configurable: true,
      enumerable: true,
      get: () => !_isPlaying
    });

    Object.defineProperty(audio, 'volume', {
      configurable: true,
      enumerable: true,
      get: () => _volume,
      set: (val) => {
        _volume = Math.max(0, Math.min(1, Number(val) || 0));
        invoke('rust_audio_set_volume', { volume: _muted ? 0 : _volume }).catch(() => {});
        audio.dispatchEvent(new Event('volumechange'));
      }
    });

    Object.defineProperty(audio, 'muted', {
      configurable: true,
      enumerable: true,
      get: () => _muted,
      set: (val) => {
        _muted = !!val;
        invoke('rust_audio_set_volume', { volume: _muted ? 0 : _volume }).catch(() => {});
        audio.dispatchEvent(new Event('volumechange'));
      }
    });

    Object.defineProperty(audio, 'playbackRate', {
      configurable: true,
      enumerable: true,
      get: () => _speed,
      set: (val) => {
        _speed = Math.max(0.25, Math.min(4, Number(val) || 1));
        invoke('rust_audio_set_speed', { speed: _speed }).catch(() => {});
      }
    });

    Object.defineProperty(audio, 'readyState', {
      configurable: true,
      enumerable: true,
      get: () => (_isLoading ? 1 : 4)
    });

    Object.defineProperty(audio, 'seeking', {
      configurable: true,
      enumerable: true,
      get: () => false
    });

    Object.defineProperty(audio, 'ended', {
      configurable: true,
      enumerable: true,
      get: () => _hasEnded
    });

    audio.play = () => {
      _isPlaying = true;
      _hasEnded = false;
      audio.dispatchEvent(new Event('play'));
      if (_isLoading) {
        audio.dispatchEvent(new Event('waiting'));
      } else {
        audio.dispatchEvent(new Event('playing'));
      }
      invoke('taskbar_playback_state', { playing: true }).catch(() => {});
      return invoke('rust_audio_play').then(() => {}).catch(e => {
        _isPlaying = false;
        throw e;
      });
    };

    audio.pause = () => {
      _isPlaying = false;
      cachedRustFreqData.fill(0);
      audio.dispatchEvent(new Event('pause'));
      invoke('taskbar_playback_state', { playing: false }).catch(() => {});
      return invoke('rust_audio_pause').catch(() => {});
    };

    audio.load = () => {};

    // Continuous sync loop with Rust audio core state
    let lastDispatchedPos = 0;
    let isFetchingState = false;
    let idleTicks = 0;
    setInterval(() => {
      if (isFetchingState) return;
      if (!_isPlaying && !_isLoading) {
        if (document.hidden) return;
        idleTicks = (idleTicks + 1) % 6;
        if (idleTicks !== 0) return; // Poll only ~3.5x/sec when paused in foreground
      } else {
        idleTicks = 0;
      }
      isFetchingState = true;
      const pollToken = currentLoadToken;
      invoke('rust_audio_get_state').then(st => {
        if (!st || pollToken !== currentLoadToken) return;
        if (_isLoading || st.loading) {
          _currentPosition = 0;
          if (typeof st.duration === 'number' && st.duration > 0 && st.duration !== _currentDuration) {
            _currentDuration = st.duration;
            audio.dispatchEvent(new Event('durationchange'));
          }
          return;
        }
        const wasPlaying = _isPlaying;
        _isPlaying = !!st.playing;
        const rawPos = typeof st.position === 'number' ? st.position : 0;
        if (performance.now() - lastSeekMs < 350 && Math.abs(rawPos - lastSeekTarget) > 1.5) {
          _currentPosition = lastSeekTarget;
        } else {
          _currentPosition = rawPos;
        }
        
        if (typeof st.duration === 'number' && st.duration > 0 && st.duration !== _currentDuration) {
          _currentDuration = st.duration;
          audio.dispatchEvent(new Event('durationchange'));
        }

        if (st.ended && !_hasEnded) {
          notifyTrackEnded();
        } else if (!st.ended && _hasEnded) {
          _hasEnded = false;
        }

        if (_isPlaying && Math.abs(_currentPosition - lastDispatchedPos) >= 0.05) {
          lastDispatchedPos = _currentPosition;
          audio.dispatchEvent(new Event('timeupdate'));
        }

        if (!wasPlaying && _isPlaying) {
          audio.dispatchEvent(new Event('play'));
          audio.dispatchEvent(new Event('playing'));
          invoke('taskbar_playback_state', { playing: true }).catch(() => {});
        } else if (wasPlaying && !_isPlaying && !st.ended) {
          audio.dispatchEvent(new Event('pause'));
          invoke('taskbar_playback_state', { playing: false }).catch(() => {});
        }
      }).catch(() => {}).finally(() => {
        isFetchingState = false;
      });
    }, 55);

    // Demand-driven FFT polling via rustAudioGetFrequencyData avoids background IPC when visualizers are hidden
  };

  const tryHookNativeAudio = () => {
    const el = document.getElementById('native-audio') || document.querySelector('audio');
    if (el) hookNativeAudioElement(el);
  };
  tryHookNativeAudio();
  document.addEventListener('DOMContentLoaded', tryHookNativeAudio);
  setTimeout(tryHookNativeAudio, 250);

  // Restore playlists, favorites, and history from disk storage into active runtime
  const applyDiskStorage = (data) => {
    if (!data || typeof data !== 'object') return;
    let changed = false;
    for (const [k, v] of Object.entries(data)) {
      try {
        const valStr = typeof v === 'string' ? v : JSON.stringify(v);
        const existing = localStorage.getItem(k);
        if (!existing || (k === 'devsize_playlists' && (existing === '[]' || existing.length < 5))) {
          localStorage.setItem(k, valStr);
          changed = true;
        }
      } catch (_) {}
    }
    if (changed) {
      try { window.dispatchEvent(new CustomEvent('raser:cloud-library-updated')); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('raser:playlist-changed')); } catch (_) {}
    }
  };

  if (window.__RASER_INITIAL_STORAGE__) {
    applyDiskStorage(window.__RASER_INITIAL_STORAGE__);
  }
  invoke('get_disk_storage').then(data => {
    if (data) {
      window.__RASER_INITIAL_STORAGE__ = data;
      applyDiskStorage(data);
    }
  }).catch(() => {});

  // Automatically sync playback state with Windows Taskbar Thumbnail Toolbar (Play/Pause button icon)
  document.addEventListener('DOMContentLoaded', () => {
    const attachAudioListeners = () => {
      const audio = document.getElementById('native-audio') || document.querySelector('audio');
      if (audio && !audio.__taskbarAttached) {
        audio.__taskbarAttached = true;
        audio.addEventListener('play', () => invoke('taskbar_playback_state', { playing: true }));
        audio.addEventListener('playing', () => invoke('taskbar_playback_state', { playing: true }));
        audio.addEventListener('pause', () => invoke('taskbar_playback_state', { playing: false }));
        audio.addEventListener('ended', () => invoke('taskbar_playback_state', { playing: false }));
      }
    };
    attachAudioListeners();
    setTimeout(attachAudioListeners, 1000);
  });

  // Enable seamless dragging for frameless Material You titlebar
  document.addEventListener('DOMContentLoaded', () => {
    const dragArea = document.querySelector('.titlebar-drag');
    if (dragArea) {
      dragArea.addEventListener('mousedown', (e) => {
        if (e.button === 0 && !e.target.closest('button, input, select, a')) {
          if (window.__TAURI__ && window.__TAURI__.window) {
            try {
              window.__TAURI__.window.getCurrentWindow().startDragging();
            } catch (_) {}
          }
        }
      });
    }
  });
})();
