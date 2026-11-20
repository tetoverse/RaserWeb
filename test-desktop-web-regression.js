const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const firebaseClientSrc = fs.readFileSync(path.join(__dirname, 'desktop-web', 'firebase-client.js'), 'utf8');
const tauriBridgeSrc = fs.readFileSync(path.join(__dirname, 'desktop-web', 'tauri-bridge.js'), 'utf8');
const audioEngineSrc = fs.readFileSync(path.join(__dirname, 'desktop-web', 'audio.js'), 'utf8');

function createMockEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = listeners.get(event && event.type) || [];
      for (const fn of [...list]) {
        fn.call(this, event);
      }
      return true;
    },
    _listeners: listeners,
  };
}

function createMockAudioElement() {
  const target = createMockEventTarget();
  let nativeSrc = '';
  let nativePaused = true;
  let nativeCurrentTime = 0;
  let nativeVolume = 1;
  let nativeMuted = false;
  let nativePlaybackRate = 1;
  const nativePlayCalls = [];
  const nativePauseCalls = [];

  const nativePlay = function () {
    nativePaused = false;
    nativePlayCalls.push(nativeSrc);
    return Promise.resolve();
  };
  const nativePause = function () {
    nativePaused = true;
    nativePauseCalls.push(nativeSrc);
  };
  const nativeLoad = function () {};

  const audio = Object.assign(target, {
    id: 'native-audio',
    preload: 'auto',
    crossOrigin: 'anonymous',
    removeAttribute(name) {
      if (name === 'src') nativeSrc = '';
    },
    play: nativePlay,
    pause: nativePause,
    load: nativeLoad,
    _nativePlay: nativePlay,
    _nativePause: nativePause,
    _nativePlayCalls: nativePlayCalls,
    _nativePauseCalls: nativePauseCalls,
  });

  Object.defineProperties(audio, {
    src: {
      configurable: true,
      enumerable: true,
      get: () => nativeSrc,
      set: (val) => { nativeSrc = String(val || ''); },
    },
    paused: {
      configurable: true,
      enumerable: true,
      get: () => nativePaused,
    },
    currentTime: {
      configurable: true,
      enumerable: true,
      get: () => nativeCurrentTime,
      set: (val) => { nativeCurrentTime = Number(val) || 0; },
    },
    duration: {
      configurable: true,
      enumerable: true,
      get: () => 180,
    },
    volume: {
      configurable: true,
      enumerable: true,
      get: () => nativeVolume,
      set: (val) => { nativeVolume = Number(val); },
    },
    muted: {
      configurable: true,
      enumerable: true,
      get: () => nativeMuted,
      set: (val) => { nativeMuted = !!val; },
    },
    playbackRate: {
      configurable: true,
      enumerable: true,
      get: () => nativePlaybackRate,
      set: (val) => { nativePlaybackRate = Number(val); },
    },
    readyState: {
      configurable: true,
      enumerable: true,
      get: () => 4,
    },
  });

  return audio;
}

function runBridgeInSandbox({ windowOverrides = {}, loadAudioEngine = false } = {}) {
  const audio = createMockAudioElement();
  const intervals = [];
  const timeouts = [];
  const storageMap = new Map();

  const windowTarget = createMockEventTarget();
  const documentTarget = createMockEventTarget();

  const documentObj = Object.assign(documentTarget, {
    hidden: false,
    documentElement: { classList: { contains: () => false } },
    getElementById: (id) => (id === 'native-audio' ? audio : null),
    querySelector: (sel) => (sel === 'audio' ? audio : null),
  });

  const localStorageObj = {
    get length() { return storageMap.size; },
    key: (i) => Array.from(storageMap.keys())[i] ?? null,
    getItem: (k) => (storageMap.has(String(k)) ? storageMap.get(String(k)) : null),
    setItem: (k, v) => { storageMap.set(String(k), String(v)); },
    removeItem: (k) => { storageMap.delete(String(k)); },
  };

  class MockEvent {
    constructor(type) { this.type = type; }
  }
  class MockCustomEvent extends MockEvent {
    constructor(type, init = {}) {
      super(type);
      this.detail = init.detail;
    }
  }

  let audioContextCreated = 0;
  const mockParam = (v = 0) => ({
    value: v,
    setValueAtTime() {},
    setTargetAtTime() {},
    cancelScheduledValues() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
  });
  class MockAudioContext {
    constructor() {
      audioContextCreated++;
      this.state = 'running';
      this.sampleRate = 48000;
      this.currentTime = 0;
      this.destination = {};
    }
    createGain() { return { gain: mockParam(1), connect() {}, disconnect() {} }; }
    createDynamicsCompressor() { return { threshold: mockParam(0), knee: mockParam(0), ratio: mockParam(1), attack: mockParam(0), release: mockParam(0), connect() {}, disconnect() {} }; }
    createBiquadFilter() { return { type: '', frequency: mockParam(0), Q: mockParam(1), gain: mockParam(0), connect() {}, disconnect() {} }; }
    createWaveShaper() { return { oversample: 'none', curve: null, connect() {}, disconnect() {} }; }
    createDelay() { return { delayTime: mockParam(0), connect() {}, disconnect() {} }; }
    createConvolver() { return { buffer: null, connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 128, frequencyBinCount: 64, connect() {}, disconnect() {}, getByteFrequencyData() {} }; }
    createBuffer(_ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }

  const windowObj = Object.assign(windowTarget, {
    innerWidth: 1280,
    AudioContext: MockAudioContext,
    Event: MockEvent,
    CustomEvent: MockCustomEvent,
    open: () => null,
    location: { protocol: 'https:', origin: 'https://app.raserapp.online', hostname: 'app.raserapp.online' },
    ...windowOverrides,
  });

  const sandbox = {
    window: windowObj,
    document: documentObj,
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36' },
    localStorage: localStorageObj,
    performance: { now: () => 1000 },
    Event: MockEvent,
    CustomEvent: MockCustomEvent,
    URL,
    Uint8Array,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout: () => {},
  };
  windowObj.window = windowObj;
  sandbox.globalThis = windowObj;

  const context = vm.createContext(sandbox);
  if (loadAudioEngine) {
    vm.runInContext(audioEngineSrc, context, { filename: 'desktop-web/audio.js' });
  }
  vm.runInContext(tauriBridgeSrc, context, { filename: 'desktop-web/tauri-bridge.js' });

  return {
    window: windowObj,
    document: documentObj,
    audio,
    intervals,
    timeouts,
    getAudioContextCount: () => audioContextCreated,
  };
}

test('server.js serves static assets with brotli/gzip compression and ETag revalidation', () => {
  assert.match(serverSrc, /require\('zlib'\)/);
  assert.match(serverSrc, /createBrotliCompress\(\)/);
  assert.match(serverSrc, /createGzip\(\)/);
  assert.match(serverSrc, /if-none-match/);
  assert.match(serverSrc, /res\.writeHead\(304,/);
  assert.match(serverSrc, /no-cache, must-revalidate/);
});

test('desktop-web/firebase-client.js handles redirect results and falls back to signInWithRedirect', () => {
  assert.match(firebaseClientSrc, /auth\.getRedirectResult\(\)/);
  assert.match(firebaseClientSrc, /auth\.signInWithPopup\(provider\)/);
  assert.match(firebaseClientSrc, /auth\/popup-blocked/);
  assert.match(firebaseClientSrc, /auth\.signInWithRedirect\(provider\)/);
});

test('tauri-bridge.js does not hijack normal browser HTML audio or set isTauri', async () => {
  const env = runBridgeInSandbox({ loadAudioEngine: true });

  assert.equal(env.window.electronAPI, undefined);
  assert.equal(env.window.__rustAudioActive, undefined);
  assert.equal(env.audio.__rustAudioHooked, undefined);
  assert.equal(env.intervals.length, 0);

  // Trigger deferred DOMContentLoaded and timers to confirm nothing hooks audio later
  env.document.dispatchEvent(new env.window.Event('DOMContentLoaded'));
  env.window.dispatchEvent(new env.window.Event('DOMContentLoaded'));
  for (const t of env.timeouts) t.fn();
  assert.equal(env.audio.__rustAudioHooked, undefined);
  assert.equal(env.window.electronAPI, undefined);

  // Native HTMLAudioElement remains functional in browser mode
  assert.equal(env.audio.play, env.audio._nativePlay);
  assert.equal(env.audio.pause, env.audio._nativePause);
  env.audio.src = 'https://example.com/track.mp3';
  await env.audio.play();
  assert.equal(env.audio.src, 'https://example.com/track.mp3');
  assert.equal(env.audio.paused, false);
  assert.deepEqual(env.audio._nativePlayCalls, ['https://example.com/track.mp3']);

  // RaserAudioEngine initializes browser Web Audio instead of skipping into Tauri mode
  const engine = new env.window.RaserAudioEngine();
  engine.init(env.audio);
  assert.equal(env.getAudioContextCount(), 1);
  assert.notEqual(engine.getAnalyserNode(), null);
  assert.equal(engine.getAnalyserNode().fftSize, 128);
});

test('tauri-bridge.js preserves existing Electron preload API and normal HTML audio', () => {
  const electronMinimize = () => 'electron-minimized';
  const electronStorageInit = () => ({ preserved: '1' });
  const preloadApi = {
    isWindows: true,
    platform: 'win32',
    minimizeWindow: electronMinimize,
    storageInitSync: electronStorageInit,
  };

  const env = runBridgeInSandbox({
    windowOverrides: { electronAPI: preloadApi },
  });

  assert.equal(env.window.electronAPI, preloadApi);
  assert.equal(env.window.electronAPI.isTauri, undefined);
  assert.equal(env.window.electronAPI.minimizeWindow, electronMinimize);
  assert.equal(env.window.electronAPI.storageInitSync, electronStorageInit);
  assert.equal(env.window.electronAPI.rustAudioLoad, undefined);
  assert.equal(env.window.__rustAudioActive, undefined);
  assert.equal(env.audio.__rustAudioHooked, undefined);
  assert.equal(env.audio.play, env.audio._nativePlay);
  assert.equal(env.intervals.length, 0);
});

test('tauri-bridge.js ignores stub __TAURI__ / __TAURI_INTERNALS__ objects without usable invoke', () => {
  for (const stub of [
    { __TAURI__: {} },
    { __TAURI__: { core: {} } },
    { __TAURI__: { core: { invoke: 'not-a-function' } } },
    { __TAURI_INTERNALS__: {} },
    { __TAURI_INTERNALS__: { invoke: null } },
  ]) {
    const env = runBridgeInSandbox({ windowOverrides: stub });
    assert.equal(env.window.electronAPI, undefined);
    assert.equal(env.window.__rustAudioActive, undefined);
    assert.equal(env.audio.__rustAudioHooked, undefined);
    assert.equal(env.intervals.length, 0);
  }
});

test('tauri-bridge.js activates native Rust audio and isTauri when window.__TAURI__.core.invoke exists', async () => {
  const invoked = [];
  const listenedEvents = [];
  const invoke = (cmd, args) => {
    invoked.push({ cmd, args });
    if (cmd === 'rust_audio_load') return Promise.resolve({ position: 0, duration: 215 });
    if (cmd === 'rust_audio_get_state') return Promise.resolve({ playing: true, position: 12, duration: 215, loading: false, ended: false });
    return Promise.resolve(null);
  };

  const env = runBridgeInSandbox({
    loadAudioEngine: true,
    windowOverrides: {
      __TAURI__: {
        core: { invoke },
        event: { listen: (name) => { listenedEvents.push(name); } },
      },
    },
  });

  assert.equal(env.window.electronAPI?.isTauri, true);
  assert.equal(env.window.__rustAudioActive, true);
  assert.equal(env.audio.__rustAudioHooked, true);
  assert.ok(env.intervals.length >= 1, 'should start Rust audio state sync interval in Tauri mode');
  assert.ok(listenedEvents.includes('media-command'));
  assert.ok(listenedEvents.includes('rust-audio-ended'));

  env.audio.src = 'https://cdn.example.com/audio.mp3';
  await env.audio.play();
  env.audio.currentTime = 25;
  env.audio.pause();

  const cmds = invoked.map((c) => c.cmd);
  assert.ok(cmds.includes('rust_audio_load'));
  assert.ok(cmds.includes('rust_audio_play'));
  assert.ok(cmds.includes('rust_audio_seek'));
  assert.ok(cmds.includes('rust_audio_pause'));

  // RaserAudioEngine should honor Tauri native mode and avoid creating a Web AudioContext
  const engine = new env.window.RaserAudioEngine();
  engine.init(env.audio);
  assert.equal(env.getAudioContextCount(), 0);
  assert.equal(engine.getAnalyserNode()?.frequencyBinCount, 64);
});

test('tauri-bridge.js activates native Rust audio when window.__TAURI_INTERNALS__.invoke exists', async () => {
  const invoked = [];
  const invoke = (cmd, args) => {
    invoked.push({ cmd, args });
    if (cmd === 'rust_audio_load') return Promise.resolve({ position: 0, duration: 120 });
    return Promise.resolve(null);
  };

  const env = runBridgeInSandbox({
    windowOverrides: {
      __TAURI_INTERNALS__: { invoke },
    },
  });

  assert.equal(env.window.electronAPI?.isTauri, true);
  assert.equal(env.window.__rustAudioActive, true);
  assert.equal(env.audio.__rustAudioHooked, true);

  env.audio.src = 'https://cdn.example.com/audio.mp3';
  await env.audio.play();

  const cmds = invoked.map((c) => c.cmd);
  assert.ok(cmds.includes('rust_audio_load'));
  assert.ok(cmds.includes('rust_audio_play'));
});
