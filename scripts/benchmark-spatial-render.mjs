/** Reproducible local orbit comparison. No extrapolation to other hardware. */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
const fixture = await fs.readFile(
  'output/spatial-review/austin-osm-ways.json',
  'utf8',
);
const browser = await puppeteer.launch({
  headless: false,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    '--use-angle=metal',
    '--enable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage();
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.bringToFront();
  await page.evaluateOnNewDocument((payload) => {
    const original = window.fetch;
    window.fetch = function (input, init) {
      return String(input).includes('/api/overpass') &&
        String(init?.body).includes('building')
        ? Promise.resolve(
            new Response(payload, {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : original.call(this, input, init);
    };
  }, fixture);
  await page.goto(
    'http://localhost:4173/?welcome=0#v=2&lat=30.2618&lon=-97.7431&alt=1400&heading=0&pitch=-65&roll=0&style=normal&bloom=0&sharpen=0&bi=0&bv=2&sc=0&map=esri-imagery',
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.spatialWorkspace &&
      document.querySelector('#loading-screen')?.classList.contains('hidden') &&
      window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 60000 },
  );
  await page.click('.spatial-launch');
  await page.click('[data-action="load"]');
  await page.waitForFunction(
    () => window.__godsEyeView.spatialWorkspace.diagnostics().loaded > 0,
  );
  await page.click('[data-action="all"]');
  await page.click('[data-question="use"]');
  await new Promise((r) => setTimeout(r, 3000));
  async function orbit(show) {
    return page.evaluate(async (show) => {
      const v = window.__godsEyeView.viewer,
        C = window.__CESIUM__,
        source = v.dataSources.getByName('gev-spatial-buildings')[0];
      source.show = show;
      const times = [],
        frames = [],
        longTasks = [];
      let last = 0,
        frame = 0;
      const observe = new PerformanceObserver((list) =>
        longTasks.push(...list.getEntries().map((e) => e.duration)),
      );
      observe.observe({ type: 'longtask' });
      const off = v.scene.postRender.addEventListener(() => {
        if (frame > 30) frames.push(performance.now());
      });
      await new Promise((resolve) => {
        function step(t) {
          if (frame > 30 && last) times.push(t - last);
          last = t;
          v.camera.lookAt(
            C.Cartesian3.fromDegrees(-97.7431, 30.2672, 150),
            new C.HeadingPitchRange(
              Math.sin((frame / 180) * Math.PI) * 0.28,
              -1.08,
              1550,
            ),
          );
          v.scene.requestRender();
          frame++;
          if (frame < 210) requestAnimationFrame(step);
          else resolve();
        }
        requestAnimationFrame(step);
      });
      off();
      observe.disconnect();
      v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      times.sort((a, b) => a - b);
      return {
        visible: show,
        samples: times.length,
        rafP50Ms: times[Math.floor(times.length * 0.5)],
        rafP95Ms: times[Math.floor(times.length * 0.95)],
        renderedFrames: frames.length,
        renderFps:
          frames.length > 1
            ? (1000 * (frames.length - 1)) / (frames.at(-1) - frames[0])
            : 0,
        longTasks,
        heapBytes: performance.memory?.usedJSHeapSize,
      };
    }, show);
  }
  await orbit(true); // Warm geometry/shaders and terrain along the orbit.
  const baseline = await orbit(false),
    buildings = await orbit(true);
  await page.screenshot({
    path: 'output/spatial-review/performance-orbit.png',
  });
  const idle = await page.evaluate(async () => {
    const v = window.__godsEyeView.viewer;
    let count = 0;
    const off = v.scene.postRender.addEventListener(() => count++);
    await new Promise((r) => setTimeout(r, 3000));
    off();
    return { requestRenderMode: v.scene.requestRenderMode, framesIn3s: count };
  });
  const report = {
    environment:
      'Local Mac, system Chrome, Metal, visible window, 1440×900. Real 471-record OSM replay, live Esri imagery. Warm scripted orbit; recording disabled.',
    baseline,
    buildings,
    idle,
    diagnostics: await page.evaluate(() =>
      window.__godsEyeView.spatialWorkspace.diagnostics(),
    ),
  };
  await fs.writeFile(
    'output/spatial-review/render-benchmark.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
