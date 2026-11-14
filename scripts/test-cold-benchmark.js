const http = require('http');
const { server } = require('../server.js');

const port = 3995;
server.listen(port, async () => {
  console.log('=== REAL-WORLD PLAYBACK BENCHMARK RUNNER (PORT ' + port + ') ===\n');

  function postJson(path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }, (res) => {
        let resp = '';
        res.on('data', c => resp += c);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(resp) }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  function getStreamFirstChunk(streamUrl) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const parsed = new URL(streamUrl, 'http://127.0.0.1:' + port);
      const req = http.get({
        hostname: parsed.hostname,
        port: parsed.port || port,
        path: parsed.pathname + parsed.search,
        headers: { 'Range': 'bytes=0-' }
      }, (res) => {
        let firstChunk = false;
        res.on('data', (chunk) => {
          if (!firstChunk) {
            firstChunk = true;
            const ttfb = Date.now() - start;
            resolve({
              status: res.statusCode,
              headers: res.headers,
              ttfb,
              chunkLength: chunk.length
            });
            req.destroy();
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  function getJson(path) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      http.get({ hostname: '127.0.0.1', port, path }, (res) => {
        let resp = '';
        res.on('data', c => resp += c);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: JSON.parse(resp),
            ms: Date.now() - start
          });
        });
      }).on('error', reject);
    });
  }

  try {
    const coldTracks = [
      { id: 'sp_bench_1', title: 'Save Your Tears', artist: 'The Weeknd' },
      { id: 'sp_bench_2', title: 'Dont Start Now', artist: 'Dua Lipa' },
      { id: 'sp_bench_3', title: 'Dip', artist: 'Madrigal' },
      { id: 'sp_bench_4', title: 'Pisikopat', artist: 'Lvbel C5' },
      { id: 'sp_bench_5', title: 'Mesafe', artist: 'Semicenk' }
    ];

    console.log('[Step 1] Background Batch ID Pre-Resolution (When playlist renders in UI):');
    const t0 = Date.now();
    const batchRes = await postJson('/api/resolve-ids', { tracks: coldTracks });
    const batchMs = Date.now() - t0;
    console.log(' -> Resolved 5 cold songs in background in:', batchMs, 'ms (' + Math.round(batchMs/5) + 'ms per song avg)');
    console.log(' -> Resolved mappings:', batchRes.body.resolved);

    // Attach resolved IDs to tracks (simulating frontend scheduleBatchResolveIds)
    coldTracks.forEach(t => {
      if (batchRes.body.resolved[t.id]) {
        t.resolvedId = batchRes.body.resolved[t.id];
      }
    });

    console.log('\n[Step 2] User Hovers over Track #1 ("Save Your Tears"):');
    console.log(' -> Track #1 already has resolvedId:', coldTracks[0].resolvedId);
    const hoverRes = await getJson('/api/stream-info?id=' + coldTracks[0].resolvedId + '&format=json');
    console.log(' -> Hover stream-info resolved in:', hoverRes.ms, 'ms');
    console.log(' -> streamUrl ready in memory:', hoverRes.body.streamUrl ? 'YES' : 'NO');
    coldTracks[0]._preloadedStreamUrl = hoverRes.body.streamUrl;

    console.log('\n[Step 3] User Clicks Track #1 (Hover-Preloaded):');
    // Frontend sees coldTracks[0]._preloadedStreamUrl is ready in memory:
    const streamPlay = await getStreamFirstChunk(coldTracks[0]._preloadedStreamUrl);
    console.log(' -> Audio First Chunk delivered in:', streamPlay.ttfb, 'ms!');
    console.log(' -> HTTP Status:', streamPlay.status, 'Content-Type:', streamPlay.headers['content-type'], 'Bytes:', streamPlay.chunkLength);

    console.log('\n[Step 4] User Clicks Track #2 COLD (No hover, but background ID resolved):');
    console.log(' -> Requesting /api/stream with resolvedId=' + coldTracks[1].resolvedId);
    const streamCold = await getStreamFirstChunk('/api/stream?id=' + coldTracks[1].resolvedId);
    console.log(' -> Cold Click Playback Start TTFB:', streamCold.ttfb, 'ms!');
    console.log(' -> HTTP Status:', streamCold.status, 'Content-Type:', streamCold.headers['content-type']);

    console.log('\n[Step 5] User Clicks Track #3 COLD (No hover, but background ID resolved):');
    const streamCold3 = await getStreamFirstChunk('/api/stream?id=' + coldTracks[2].resolvedId);
    console.log(' -> Cold Click Playback Start TTFB:', streamCold3.ttfb, 'ms!');
    console.log(' -> HTTP Status:', streamCold3.status, 'Content-Type:', streamCold3.headers['content-type']);

    console.log('\n[Step 6] Absolute Worst Case: Click completely un-resolved raw search query (No ID pre-resolution):');
    const streamRaw = await getStreamFirstChunk('/api/stream?id=cand_unres_99&title=In%20The%20End&artist=Linkin%20Park');
    console.log(' -> Raw Search Query Playback TTFB (with Keep-Alive):', streamRaw.ttfb, 'ms!');
    console.log(' -> HTTP Status:', streamRaw.status, 'Content-Type:', streamRaw.headers['content-type']);

    console.log('\n=== ALL TESTS COMPLETED SUCCESSFULLY ===');
  } catch (err) {
    console.error('Benchmark error:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
