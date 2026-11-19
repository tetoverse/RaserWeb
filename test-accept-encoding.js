const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { server } = require('./server');

let baseUrl;

function request(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Accept-Encoding HTTP integration tests', () => {
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

  it('serves brotli when Accept-Encoding: br', async () => {
    const res = await request('/index.html', { 'Accept-Encoding': 'br' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    const decompressed = zlib.brotliDecompressSync(res.body).toString('utf8');
    assert.match(decompressed, /<!DOCTYPE html>/i);
  });

  it('serves gzip when Accept-Encoding: gzip', async () => {
    const res = await request('/index.html', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    const decompressed = zlib.gunzipSync(res.body).toString('utf8');
    assert.match(decompressed, /<!DOCTYPE html>/i);
  });

  it('serves identity when Accept-Encoding: identity or omitted', async () => {
    const res1 = await request('/index.html', { 'Accept-Encoding': 'identity' });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.headers['content-encoding'], undefined);
    assert.match(res1.body.toString('utf8'), /<!DOCTYPE html>/i);

    const res2 = await request('/index.html');
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.headers['content-encoding'], undefined);
    assert.match(res2.body.toString('utf8'), /<!DOCTYPE html>/i);
  });

  it('never sends br when br;q=0,gzip;q=1 and serves gzip instead', async () => {
    const res = await request('/index.html', { 'Accept-Encoding': 'br;q=0,gzip;q=1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    const decompressed = zlib.gunzipSync(res.body).toString('utf8');
    assert.match(decompressed, /<!DOCTYPE html>/i);
  });

  it('falls back to identity when br;q=0, gzip;q=0', async () => {
    const res = await request('/index.html', { 'Accept-Encoding': 'br;q=0, gzip;q=0' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], undefined);
    assert.match(res.body.toString('utf8'), /<!DOCTYPE html>/i);
  });

  it('returns 406 Not Acceptable when all representations have q=0', async () => {
    const res1 = await request('/index.html', { 'Accept-Encoding': 'br;q=0, gzip;q=0, identity;q=0' });
    assert.equal(res1.statusCode, 406);

    const res2 = await request('/index.html', { 'Accept-Encoding': '*;q=0' });
    assert.equal(res2.statusCode, 406);
  });

  it('respects quality preference and breaks ties deterministically (br > gzip)', async () => {
    const resHigherGzip = await request('/index.html', { 'Accept-Encoding': 'br;q=0.5, gzip;q=0.9' });
    assert.equal(resHigherGzip.statusCode, 200);
    assert.equal(resHigherGzip.headers['content-encoding'], 'gzip');

    const resTie = await request('/index.html', { 'Accept-Encoding': 'gzip;q=0.8, br;q=0.8' });
    assert.equal(resTie.statusCode, 200);
    assert.equal(resTie.headers['content-encoding'], 'br');
  });

  it('handles wildcard and malformed Accept-Encoding values safely', async () => {
    const resWildcard = await request('/index.html', { 'Accept-Encoding': '*;q=0.5, br;q=0' });
    assert.equal(resWildcard.statusCode, 200);
    assert.equal(resWildcard.headers['content-encoding'], 'gzip');

    const resMalformed = await request('/index.html', { 'Accept-Encoding': 'br;q=invalid, ;;;, gzip;q=0.7' });
    assert.equal(resMalformed.statusCode, 200);
    assert.equal(resMalformed.headers['content-encoding'], 'gzip');
  });
});
