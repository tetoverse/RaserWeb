const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { server, DEFAULT_MAX_BODY_BYTES } = require('./server');

let baseUrl;

function request(method, pathname, { headers = {}, body = null, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) {
      if (chunked) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const mid = Math.floor(buf.length / 2);
        req.write(buf.subarray(0, mid));
        req.write(buf.subarray(mid));
        req.end();
      } else {
        req.end(body);
      }
    } else {
      req.end();
    }
  });
}

describe('bounded request-body reader', () => {
  before((_, done) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  after((_, done) => {
    server.close(done);
  });

  it('accepts a valid JSON payload just under/at DEFAULT_MAX_BODY_BYTES', async () => {
    const prefix = '{"sessionId":"s1","auth":"';
    const suffix = '"}';
    const padLen = DEFAULT_MAX_BODY_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const payload = prefix + 'a'.repeat(padLen) + suffix;
    assert.equal(Buffer.byteLength(payload), DEFAULT_MAX_BODY_BYTES);

    const res = await request('POST', '/api/desktop-auth-session', {
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.success, true);
  });

  for (const route of [
    '/api/shorten',
    '/api/vibe',
    '/api/i18n-batch',
    '/api/translate',
    '/api/desktop-auth-session',
    '/api/prewarm-ids'
  ]) {
    it(`returns 413 Payload Too Large for oversized body on ${route}`, async () => {
      const oversized = 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1);
      const res = await request('POST', route, {
        headers: { 'Content-Type': 'application/json' },
        body: oversized
      });
      assert.equal(res.status, 413);
      assert.equal(res.json?.success, false);
      assert.equal(res.json?.error, 'Payload Too Large');
    });
  }

  it('enforces byte limit on chunked requests without Content-Length', async () => {
    const oversized = 'x'.repeat(DEFAULT_MAX_BODY_BYTES + 1);
    const res = await request('POST', '/api/shorten', {
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: oversized,
      chunked: true
    });
    assert.equal(res.status, 413);
    assert.equal(res.json?.error, 'Payload Too Large');
  });

  it('enforces limit in bytes rather than UTF-8 character count', async () => {
    // 'é' is 2 bytes in UTF-8; character count is below limit, byte count is over limit
    const chars = Math.floor(DEFAULT_MAX_BODY_BYTES / 2) + 1;
    const payload = 'é'.repeat(chars);
    assert.ok(payload.length < DEFAULT_MAX_BODY_BYTES);
    assert.ok(Buffer.byteLength(payload, 'utf8') > DEFAULT_MAX_BODY_BYTES);

    const res = await request('POST', '/api/vibe', {
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: payload,
      chunked: true
    });
    assert.equal(res.status, 413);
  });

  it('handles aborted requests safely and keeps server healthy', async () => {
    await new Promise((resolve) => {
      const url = new URL('/api/shorten', baseUrl);
      const req = http.request(url, { method: 'POST' });
      req.on('error', () => resolve());
      req.write('{"n":"partial');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });

    const health = await request('GET', '/api/desktop-auth-session?sessionId=nonexistent');
    assert.equal(health.status, 200);
    assert.equal(health.json?.ready, false);
  });
});
