const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webplayerHtml = fs.readFileSync(path.join(__dirname, 'webplayer.html'), 'utf8');

test('webplayer.html fetches stream metadata from /api/stream-info instead of /api/stream', () => {
  assert.doesNotMatch(
    webplayerHtml,
    /fetch\(`\/api\/stream\?id=/,
    'webplayer.html must not fetch JSON from /api/stream?id= because it returns audio/mp4 unless format=json'
  );
  const streamInfoMatches = webplayerHtml.match(/fetch\(`\/api\/stream-info\?id=/g) || [];
  assert.equal(
    streamInfoMatches.length,
    2,
    'webplayer.html should call /api/stream-info?id= for both track.id and YouTube URL fallback'
  );
});

test('webplayer.html handles audio.play() promise rejections and media errors', () => {
  assert.match(
    webplayerHtml,
    /audio\.addEventListener\('error'/,
    'webplayer.html must register an error event listener on the audio element'
  );
  assert.match(
    webplayerHtml,
    /await audio\.play\(\);[\s\S]*?catch \(err\)[\s\S]*?setPlayState\(false\)/,
    'webplayer.html must catch audio.play() rejections and reset play state'
  );
  assert.match(
    webplayerHtml,
    /audio\.play\(\)\.catch\(/,
    'webplayer.html must handle audio.play() promise rejection in ended/repeat handler'
  );
});
