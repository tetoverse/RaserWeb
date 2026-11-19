const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const firebaseClientSrc = fs.readFileSync(path.join(__dirname, 'desktop-web', 'firebase-client.js'), 'utf8');

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
