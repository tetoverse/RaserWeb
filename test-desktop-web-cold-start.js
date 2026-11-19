const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const PORT = process.env.PERF_PORT || '4174';
const RUNS = 3;

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

(async () => {
  const srv = spawn('node', ['server.js'], {
    env: { ...process.env, PORT },
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/desktop-web/`);
    browser = await chromium.launch();
    const runs = [];

    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.addInitScript(() => {
        window.__perf = { longTasks: [], lcp: 0 };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
          }
        }).observe({ type: 'longtask', buffered: true });
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length) {
            window.__perf.lcp = entries[entries.length - 1].startTime;
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });

      await page.goto(`http://127.0.0.1:${PORT}/desktop-web/`, { waitUntil: 'load' });
      await page.waitForTimeout(500);

      const metrics = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paint = performance.getEntriesByType('paint');
        const fcp = paint.find((p) => p.name === 'first-contentful-paint')?.startTime || 0;
        const resources = performance.getEntriesByType('resource');
        const jsBytes = resources
          .filter((r) => r.initiatorType === 'script')
          .reduce((a, r) => a + (r.decodedBodySize || 0), 0);
        const cssBytes = resources
          .filter((r) => r.initiatorType === 'link' && r.name.includes('.css'))
          .reduce((a, r) => a + (r.decodedBodySize || 0), 0);
        return {
          dcl: Math.round(nav.domContentLoadedEventEnd),
          load: Math.round(nav.loadEventEnd),
          fcp: Math.round(fcp),
          lcp: Math.round(window.__perf.lcp),
          longTaskCount: window.__perf.longTasks.length,
          longTaskTotalMs: Math.round(window.__perf.longTasks.reduce((a, t) => a + t.dur, 0)),
          jsKB: Math.round(jsBytes / 1024),
          cssKB: Math.round(cssBytes / 1024),
          hlsLoadedOnColdStart: typeof window.Hls !== 'undefined',
        };
      });

      assert.equal(pageErrors.length, 0, `Unexpected page errors: ${pageErrors.join('; ')}`);
      assert.equal(metrics.hlsLoadedOnColdStart, false, 'hls.min.js should be lazy-loaded, not eager on cold start');
      runs.push(metrics);
      await context.close();
    }

    const summary = {
      dclMedianMs: median(runs.map((r) => r.dcl)),
      loadMedianMs: median(runs.map((r) => r.load)),
      fcpMedianMs: median(runs.map((r) => r.fcp)),
      lcpMedianMs: median(runs.map((r) => r.lcp)),
      longTaskTotalMedianMs: median(runs.map((r) => r.longTaskTotalMs)),
      jsKB: runs[0].jsKB,
      cssKB: runs[0].cssKB,
      runs,
    };

    console.log(JSON.stringify(summary, null, 2));

    // Regression budgets
    assert.ok(summary.jsKB <= 1700, `Initial JS (${summary.jsKB} KB) exceeded 1700 KB budget`);
    assert.ok(summary.longTaskTotalMedianMs < 1500, `Median long-task total (${summary.longTaskTotalMedianMs} ms) exceeded 1500 ms budget`);
    assert.ok(summary.lcpMedianMs < 5000, `Median LCP (${summary.lcpMedianMs} ms) exceeded 5000 ms budget`);
    console.log('Cold-start performance regression check PASSED.');
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
})();
