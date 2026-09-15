#!/usr/bin/env node
/** Rendered spatial acceptance. Optional real-OSM replay isolates interaction regressions. */
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
const base = process.env.QA_BASE_URL || 'http://localhost:4173';
const out = process.env.QA_SPATIAL_OUT || 'output/spatial-review/browser';
await fs.mkdir(out, { recursive: true });
const fixture = process.env.QA_OSM_FIXTURE
  ? await fs.readFile(process.env.QA_OSM_FIXTURE, 'utf8')
  : null;
const headful = process.env.QA_HEADFUL === '1';
const browser = await puppeteer.launch({
  headless: !headful,
  ...(headful
    ? {
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }
    : {}),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    headful ? '--use-angle=metal' : '--use-angle=swiftshader',
    '--enable-gpu',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
const page = await browser.newPage();
const checks = [],
  errors = [];
let recorder;
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`,
  );
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
page.on('pageerror', (e) => errors.push(e.message));
if (fixture) {
  // Intercept only this source at the fetch boundary. Global Chrome request
  // interception stalls Cesium terrain workers and produces a blank globe.
  await page.evaluateOnNewDocument((payload) => {
    const original = window.fetch;
    window.fetch = function (input, init) {
      if (
        String(input).includes('/api/overpass') &&
        String(init?.body).includes('building')
      )
        return Promise.resolve(
          new Response(payload, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      return original.call(this, input, init);
    };
  }, fixture);
}
const state = () =>
  page.evaluate(() => window.__godsEyeView.spatialWorkspace.diagnostics());
try {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.bringToFront();
  await page.goto(
    `${base}/?welcome=0#v=2&lat=30.2618&lon=-97.7431&alt=1400&heading=0&pitch=-65&roll=0&style=normal&bloom=0&sharpen=0&bi=0&bv=2&sc=0&map=esri-imagery`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.spatialWorkspace &&
      document.querySelector('#loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.waitForFunction(
    () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 45000 },
  );
  await wait(1500);
  await page.click('.spatial-launch');
  await page.click('[data-action="load"]');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.spatialWorkspace.diagnostics().loaded > 0 ||
      /unavailable|timed out/.test(
        document.querySelector('.spatial-status').textContent,
      ),
    { timeout: 50000 },
  );
  const loaded = await state();
  check(
    'real OSM buildings load within bounded count',
    loaded.loaded > 0 && loaded.loaded <= 500,
    loaded,
  );
  if (!loaded.loaded) throw new Error('No buildings loaded');
  await wait(3500);
  await page.screenshot({ path: `${out}/01-loaded.png` });
  const pixels = await sharp(
    await sharp(`${out}/01-loaded.png`)
      .extract({ left: 300, top: 220, width: 600, height: 430 })
      .toBuffer(),
  ).stats();
  check(
    'globe pixels actually render',
    pixels.channels
      .slice(0, 3)
      .every((c) => c.mean > 20 && c.mean < 230 && c.stdev > 15),
    pixels.channels.slice(0, 3).map((c) => ({ mean: c.mean, stdev: c.stdev })),
  );
  if (!checks.at(-1).pass)
    throw new Error(
      'Blank globe capture: do not accept recording or performance result',
    );
  if (process.env.QA_RECORD === '1')
    recorder = await page.screencast({
      path: `${out}/spatial-demo.webm`,
      ffmpegPath: '/opt/homebrew/bin/ffmpeg',
      fps: 24,
      quality: 24,
    });
  await page.click('[data-action="all"]');
  await page.click('[data-question="use"]');
  await wait(1500);
  check(
    'category colors and canonical count',
    (await page.$eval('.spatial-legend', (e) => !e.hidden)) &&
      (await state()).selected === loaded.loaded,
  );
  await page.screenshot({ path: `${out}/02-categories.png` });
  await page.click('.spatial-evidence summary');
  check(
    'evidence DOM is capped at 60 rows',
    await page.$$eval('.spatial-evidence-row', (rows) => rows.length <= 60),
  );
  // Inspect then frame one real record, through its visible evidence button.
  await page.click('.spatial-evidence-row button');
  await wait(1800);
  await page.screenshot({ path: `${out}/03-evidence-focus.png` });
  check(
    'camera focus retains selection',
    (await state()).selected === loaded.loaded,
  );
  check(
    'focus stays above loaded roofline',
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      const maximum = Math.max(
        ...v.dataSources
          .getByName('gev-spatial-buildings')[0]
          .entities.values.filter((e) => e.polygon)
          .map((e) => e.polygon.extrudedHeight.getValue(v.clock.currentTime)),
      );
      return (
        v.camera.positionCartographic.height > maximum + 100 &&
        v.camera.pitch < -1.5
      );
    }),
  );
  await page.click('.spatial-evidence summary');
  // Return to an overhead view with room for a drawn polygon.
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const C = window.__CESIUM__;
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-97.7431, 30.2672, 1200),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  });
  await wait(1200);
  await page.click('[data-action="draw"]');
  for (const [x, y] of [
    [470, 270],
    [760, 270],
    [760, 570],
    [470, 570],
  ])
    await page.mouse.click(x, y);
  await page.click('[data-action="finish"]');
  const drawn = await state();
  check(
    'category colors remain enabled after drawing',
    await page.$eval('.spatial-legend', (e) => !e.hidden),
  );
  check(
    'drawn area selects a subset',
    !drawn.drawing && drawn.selected > 0 && drawn.selected < loaded.loaded,
    drawn,
  );
  check(
    'previous answer marked stale',
    await page.$eval('.spatial-answer', (e) =>
      e.classList.contains('is-stale'),
    ),
  );
  await page.click('[data-question="overview"]');
  await wait(1400);
  check(
    'refresh attaches calculated answer to current revision',
    (await state()).answerRevision === (await state()).revision,
  );
  await page.screenshot({ path: `${out}/04-drawn-answer.png` });
  await page.click('[data-question="height"]');
  await wait(1400);
  check(
    'height result is explicitly recorded',
    await page.$eval('.spatial-answer-text', (e) =>
      /recorded|unrecorded/.test(e.textContent),
    ),
  );
  if (recorder) {
    await recorder.stop();
    recorder = null;
  }
  // Real canvas picking and additive selection, not a debug selection setter.
  if (process.env.QA_RECORD === '1')
    recorder = await page.screencast({
      path: `${out}/spatial-conversation.webm`,
      ffmpegPath: '/opt/homebrew/bin/ffmpeg',
      fps: 24,
      quality: 24,
    });
  const pickable = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer,
      C = window.__CESIUM__,
      result = [];
    for (const e of v.dataSources.getByName('gev-spatial-buildings')[0].entities
      .values) {
      if (!e.polygon) continue;
      const center = C.Cartographic.fromCartesian(
        C.BoundingSphere.fromPoints(e.polygon.hierarchy.getValue().positions)
          .center,
      );
      center.height =
        (v.scene.globe.getHeight(center) || 0) +
        e.polygon.extrudedHeight.getValue(v.clock.currentTime) +
        0.5;
      const p = C.SceneTransforms.worldToWindowCoordinates(
        v.scene,
        C.Cartesian3.fromRadians(
          center.longitude,
          center.latitude,
          center.height,
        ),
      );
      if (
        p &&
        p.x > 280 &&
        p.x < 880 &&
        p.y > 180 &&
        p.y < 680 &&
        v.scene.pick(p)?.id?.__gevBuildingId === e.__gevBuildingId
      )
        result.push({ x: p.x, y: p.y, id: e.__gevBuildingId });
      if (result.length === 2) break;
    }
    return result;
  });
  check(
    'visible building volumes are independently pickable',
    pickable.length === 2,
    pickable,
  );
  if (pickable.length !== 2)
    throw new Error('No pair of pickable building roofs');
  await page.mouse.click(pickable[0].x, pickable[0].y);
  await page.keyboard.down('Shift');
  await page.mouse.click(pickable[1].x, pickable[1].y);
  await page.keyboard.up('Shift');
  check(
    'Shift-click compares exactly two buildings',
    (await state()).selected === 2,
  );
  await page.type('#spatial-question-input', 'How far apart are these?');
  await page.click('.spatial-question button');
  check(
    'natural distance question gives a calculated measurement',
    await page.$eval('.spatial-answer-text', (e) =>
      /approximately .* m apart/.test(e.textContent),
    ),
  );
  await wait(1800);
  await page.screenshot({ path: `${out}/06-building-comparison.png` });
  if (process.env.QA_MODEL === '1') {
    await page.$eval('#spatial-question-input', (e) => (e.value = ''));
    await page.type(
      '#spatial-question-input',
      'Compare what we know about these two buildings. What cannot be established from this evidence?',
    );
    await page.click('.spatial-question button');
    await page.waitForFunction(
      () => !document.querySelector('.spatial-question button').disabled,
      { timeout: 50000 },
    );
    check(
      'live model explains supplied spatial evidence',
      await page.$eval('.spatial-answer-meta', (e) =>
        e.textContent.startsWith('AI explanation'),
      ),
    );
    await wait(1800);
    await page.screenshot({ path: `${out}/07-live-model-answer.png` });
  }
  if (recorder) {
    await recorder.stop();
    recorder = null;
  }
  // Deliberately late response must never overwrite a new selection.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = function (input, init) {
      if (String(input).includes('/api/openai/spatial-answer'))
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({ answer: 'STALE RESPONSE SENTINEL' }),
                  { headers: { 'Content-Type': 'application/json' } },
                ),
              ),
            900,
          ),
        );
      return original.call(this, input, init);
    };
  });
  await page.$eval(
    '#spatial-question-input',
    (e) => (e.value = 'Explain this selection'),
  );
  await page.click('.spatial-question button');
  await page.click('[data-action="all"]');
  await wait(1100);
  check(
    'late model response cannot replace a new selection',
    await page.$eval(
      '.spatial-answer-text',
      (e) => !e.textContent.includes('STALE RESPONSE SENTINEL'),
    ),
  );
  await page.click('[data-action="draw"]');
  await page.mouse.move(730, 420);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    await page.mouse.move(600 + 130 * Math.cos(a), 420 + 100 * Math.sin(a));
    await wait(40);
  }
  await page.mouse.up();
  check(
    'freehand drag closes a usable world-space area',
    !(await state()).drawing && (await state()).selected > 0,
  );
  await page.screenshot({ path: `${out}/09-freehand-area.png` });
  // Recovery and keyboard checks are kept out of the presentation clip.
  await page.click('[data-action="draw"]');
  for (const [x, y] of [
    [460, 280],
    [780, 550],
    [470, 570],
    [770, 260],
  ])
    await page.mouse.click(x, y);
  await page.click('[data-action="finish"]');
  check(
    'invalid outline restores camera',
    !(await state()).drawing &&
      (await page.evaluate(
        () =>
          window.__godsEyeView.viewer.scene.screenSpaceCameraController
            .enableInputs,
      )),
  );
  await page.click('[data-action="draw"]');
  await page.focus('[data-action="cancel"]');
  await page.keyboard.press('Enter');
  check(
    'Enter activates Cancel rather than finishing',
    !(await state()).drawing,
  );
  // Measure actual browser-side selection/query costs already instrumented by the app.
  await page.click('[data-action="all"]');
  for (let i = 0; i < 10; i++) {
    await page.click('[data-question="overview"]');
    await page.click('[data-question="use"]');
  }
  const diagnostics = await state();
  const selectionMax = Math.max(...diagnostics.metrics.selections),
    localQueryMax = Math.max(
      ...diagnostics.metrics.queries
        .filter((q) => q.kind !== 'model')
        .map((q) => q.durationMs),
    );
  check('selection feedback below 100 ms', selectionMax < 100, {
    selectionMaxMs: selectionMax,
  });
  check('local query below 250 ms', localQueryMax < 250, {
    localQueryMaxMs: localQueryMax,
  });
  await page.setViewport({ width: 390, height: 844 });
  await wait(700);
  await page.screenshot({ path: `${out}/05-mobile.png` });
  check(
    'mobile spatial panel fits viewport',
    await page.$eval('.spatial-panel', (e) => {
      const b = e.getBoundingClientRect();
      return (
        b.left >= 0 &&
        b.right <= innerWidth &&
        b.top >= 0 &&
        b.bottom <= innerHeight
      );
    }),
  );
  check(
    'mobile panel leaves meaningful map space',
    await page.$eval(
      '.spatial-panel',
      (e) => e.getBoundingClientRect().height < innerHeight * 0.65,
    ),
  );
  check(
    'spatial controls leave attribution unobscured',
    await page.evaluate(() => {
      const credit = document
        .querySelector('#cesium-credits')
        .getBoundingClientRect();
      return ['.spatial-panel', '.spatial-launch'].every((s) => {
        const b = document.querySelector(s).getBoundingClientRect();
        return (
          b.bottom <= credit.top ||
          b.top >= credit.bottom ||
          b.right <= credit.left ||
          b.left >= credit.right
        );
      });
    }),
  );
  await page.click('[data-action="draw"]');
  await page.screenshot({ path: `${out}/08-mobile-drawing.png` });
  check(
    'mobile drawing exposes the map',
    await page.$eval(
      '.spatial-panel',
      (e) => e.getBoundingClientRect().height < 180,
    ),
  );
  check(
    'mobile drawing removes unrelated controls',
    await page.$eval(
      '#command-dock',
      (e) => getComputedStyle(e).display === 'none',
    ),
  );
  await page.click('[data-action="cancel"]');
  await page.click('.spatial-close');
  check(
    'closing releases camera control',
    !(await state()).open &&
      (await page.evaluate(
        () =>
          window.__godsEyeView.viewer.scene.screenSpaceCameraController
            .enableInputs,
      )),
  );
  await page.evaluate(() => window.__godsEyeView.spatialWorkspace.destroy());
  await wait(100);
  check(
    'teardown removes data source and UI',
    await page.evaluate(
      () =>
        !document.querySelector('#spatial-workspace') &&
        !Array.from(
          { length: window.__godsEyeView.viewer.dataSources.length },
          (_, i) => window.__godsEyeView.viewer.dataSources.get(i).name,
        ).includes('gev-spatial-buildings'),
    ),
  );
  check('no browser exceptions', errors.length === 0, errors);
  await fs.writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        fixture: process.env.QA_OSM_FIXTURE || null,
        browser: await browser.version(),
        checks,
        errors,
        diagnostics,
      },
      null,
      2,
    ),
  );
} catch (error) {
  check('harness completed', false, error.message);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  await fs.writeFile(
    `${out}/report.json`,
    JSON.stringify({ checks, errors, error: error.stack }, null, 2),
  );
} finally {
  if (recorder) await recorder.stop().catch(() => {});
  await browser.close();
}
if (checks.some((c) => !c.pass)) process.exitCode = 1;
