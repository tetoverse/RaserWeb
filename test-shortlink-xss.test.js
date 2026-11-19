const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for server to start'));
      }
    }, 10000);

    child.stdout.on('data', (chunk) => {
      if (!settled && chunk.toString().includes('RaserWeb server running')) {
        settled = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited early with code ${code}`));
      }
    });
  });
}

test('GET /s/:code safely serializes track metadata without breaking out of <script>', async (t) => {
  const port = await getFreePort();
  const child = await startServer(port);
  t.after(() => {
    child.kill('SIGTERM');
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const sentinelTitle = 'Test \u2028\u2029 </script><script>/*SENTINEL_INJECTED*/</script> & end';
  const sentinelArtist = 'Artist <!-- comment -->';

  const shortenRes = await fetch(`${baseUrl}/api/shorten`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      n: sentinelTitle,
      a: sentinelArtist,
      url: 'https://example.com/track?a=1&b=2',
      dur: 123,
    }),
  });

  assert.equal(shortenRes.status, 200);
  const shortenJson = await shortenRes.json();
  assert.equal(shortenJson.success, true);
  assert.match(shortenJson.code, /^[a-zA-Z0-9]{7}$/);

  const pageRes = await fetch(`${baseUrl}/s/${shortenJson.code}`);
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();

  // The raw closing script delimiter from the sentinel must not appear in the HTML.
  assert.equal(html.includes('/*SENTINEL_INJECTED*/</script>'), false);
  assert.equal(html.includes('Test </script>'), false);

  // The injected script block must still contain valid JSON that round-trips.
  const match = html.match(/<script>window\.__PRELOADED_TRACK__ = (.*?);<\/script>/);
  assert.ok(match, 'Expected preloaded track script tag in HTML');

  const serialized = match[1];
  assert.equal(serialized.includes('<'), false);
  assert.equal(serialized.includes('>'), false);
  assert.equal(serialized.includes('&'), false);
  assert.equal(serialized.includes('\u2028'), false);
  assert.equal(serialized.includes('\u2029'), false);

  const parsed = JSON.parse(serialized);
  assert.equal(parsed.n, sentinelTitle);
  assert.equal(parsed.a, sentinelArtist);
  assert.equal(parsed.url, 'https://example.com/track?a=1&b=2');
  assert.equal(parsed.dur, 123);
});
