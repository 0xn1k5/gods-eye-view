/** Synthetic 3D Tiles integration fixture. This is not Google photogrammetry. */
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import sharp from 'sharp';
const out = 'output/spatial-review/tiles';
await fs.mkdir(out, { recursive: true });
// A glTF cube with normals, in Y-up coordinates, packed as a GLB tile.
const faces = [
  [
    [0, 0, 1],
    [
      [-25, 0, 25],
      [25, 0, 25],
      [25, 60, 25],
      [-25, 60, 25],
    ],
  ],
  [
    [0, 0, -1],
    [
      [25, 0, -25],
      [-25, 0, -25],
      [-25, 60, -25],
      [25, 60, -25],
    ],
  ],
  [
    [1, 0, 0],
    [
      [25, 0, 25],
      [25, 0, -25],
      [25, 60, -25],
      [25, 60, 25],
    ],
  ],
  [
    [-1, 0, 0],
    [
      [-25, 0, -25],
      [-25, 0, 25],
      [-25, 60, 25],
      [-25, 60, -25],
    ],
  ],
  [
    [0, 1, 0],
    [
      [-25, 60, 25],
      [25, 60, 25],
      [25, 60, -25],
      [-25, 60, -25],
    ],
  ],
  [
    [0, -1, 0],
    [
      [-25, 0, -25],
      [25, 0, -25],
      [25, 0, 25],
      [-25, 0, 25],
    ],
  ],
];
const positions = [],
  normals = [],
  indices = [];
for (const [normal, points] of faces) {
  const base = positions.length / 3;
  positions.push(...points.flat());
  normals.push(...Array(4).fill(normal).flat());
  indices.push(...[0, 1, 2, 0, 2, 3].map((i) => i + base));
}
const buffers = [
  Buffer.from(new Float32Array(positions).buffer),
  Buffer.from(new Float32Array(normals).buffer),
  Buffer.from(new Uint16Array(indices).buffer),
];
const bin = Buffer.concat(buffers),
  gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.7, 0.7, 0.7, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        doubleSided: true,
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: buffers.map((b, i) => ({
      buffer: 0,
      byteOffset: buffers.slice(0, i).reduce((n, x) => n + x.length, 0),
      byteLength: b.length,
    })),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: 'VEC3',
        min: [-25, 0, -25],
        max: [25, 60, 25],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
const json = Buffer.from(
  JSON.stringify(gltf).padEnd(
    Math.ceil(JSON.stringify(gltf).length / 4) * 4,
    ' ',
  ),
);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + json.length + bin.length, 8);
header.writeUInt32LE(json.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
const glb = Buffer.concat([header, json, binHeader, bin]).toString('base64');
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn')
    console.log(m.type(), m.text().slice(0, 600));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(
    'http://localhost:4173/?welcome=0#v=2&lat=30.2672&lon=-97.7431&alt=1600&heading=0&pitch=-90&roll=0&style=normal&bloom=0&sharpen=0&bi=0&bv=2&sc=0&map=esri-imagery',
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.spatialWorkspace &&
      document.querySelector('#loading-screen')?.classList.contains('hidden') &&
      window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 60000 },
  );
  await wait(3000);
  const fixture = await page.evaluate(async (glb) => {
    const v = window.__godsEyeView.viewer,
      C = window.__CESIUM__,
      lon = -97.7431,
      lat = 30.2672;
    const ground =
      v.scene.globe.getHeight(C.Cartographic.fromDegrees(lon, lat)) || 0;
    const transform = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(lon, lat, ground),
    );
    const root = {
      asset: { version: '1.1' },
      geometricError: 500,
      root: {
        boundingVolume: { box: [0, 0, 30, 25, 0, 0, 0, 25, 0, 0, 0, 30] },
        transform: C.Matrix4.toArray(transform),
        geometricError: 0,
        refine: 'ADD',
        content: { uri: `data:model/gltf-binary;base64,${glb}` },
      },
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(root)], { type: 'application/json' }),
    );
    const tile = await C.Cesium3DTileset.fromUrl(url);
    tile.tileFailed.addEventListener((e) =>
      console.error('tile failed', e.message),
    );
    v.scene.primitives.add(tile);
    window.__spatialTestTile = tile;
    v.camera.lookAt(
      C.Cartesian3.fromDegrees(lon, lat, ground + 30),
      new C.HeadingPitchRange(0, -0.75, 260),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);
    const coords = [
      [-27, -27],
      [27, -27],
      [27, 27],
      [-27, 27],
      [-27, -27],
    ]
      .map(([x, y]) =>
        C.Cartographic.fromCartesian(
          C.Matrix4.multiplyByPoint(
            transform,
            new C.Cartesian3(x, y, 0),
            new C.Cartesian3(),
          ),
        ),
      )
      .map((c) => ({
        lon: C.Math.toDegrees(c.longitude),
        lat: C.Math.toDegrees(c.latitude),
      }));
    const payload = {
      elements: [
        {
          type: 'way',
          id: 999999001,
          tags: {
            building: 'office',
            height: '60',
            name: 'Synthetic classification fixture',
          },
          geometry: coords,
        },
      ],
    };
    const original = window.fetch;
    window.fetch = function (input, init) {
      return String(input).includes('/api/overpass') &&
        String(init?.body).includes('building')
        ? Promise.resolve(
            new Response(JSON.stringify(payload), {
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : original.call(this, input, init);
    };
    v.scene.requestRender();
    return { ground };
  }, glb);
  await wait(8000);
  await page.screenshot({ path: `${out}/01-before.png` });
  console.log(
    'tile state',
    await page.evaluate(() => {
      const t = window.__spatialTestTile,
        C = window.__CESIUM__;
      return {
        show: t.show,
        center: C.Cartographic.fromCartesian(
          t.boundingSphere.center,
        ).toString(),
        radius: t.boundingSphere.radius,
        stats: t._statistics,
        content: t.root.content?.constructor.name,
      };
    }),
  );
  await page.click('.spatial-launch');
  await page.click('[data-action="load"]');
  await page.waitForFunction(
    () => window.__godsEyeView.spatialWorkspace.diagnostics().loaded === 1,
  );
  await page.click('[data-action="all"]');
  await wait(3000);
  await page.screenshot({ path: `${out}/02-classified.png` });
  const result = await page.evaluate(() => {
    const v = window.__godsEyeView.viewer,
      C = window.__CESIUM__,
      masks = [];
    for (let i = 0; i < v.scene.primitives.length; i++) {
      const collection = v.scene.primitives.get(i);
      if (collection instanceof C.PrimitiveCollection)
        for (let j = 0; j < collection.length; j++) {
          const p = collection.get(j);
          if (p instanceof C.ClassificationPrimitive)
            masks.push({ ready: p.ready, show: p.show });
        }
    }
    return {
      mode: window.__godsEyeView.spatialWorkspace.diagnostics().mode,
      solids: v.dataSources
        .getByName('gev-spatial-buildings')[0]
        .entities.values.filter((e) => e.polygon).length,
      masks,
      tileLoaded: window.__spatialTestTile.tilesLoaded,
      tileCommands: window.__spatialTestTile._statistics.numberOfCommands,
    };
  });
  const crop = { left: 650, top: 460, width: 120, height: 120 };
  const before = (
    await sharp(
      await sharp(`${out}/01-before.png`).extract(crop).toBuffer(),
    ).stats()
  ).channels;
  const after = (
    await sharp(
      await sharp(`${out}/02-classified.png`).extract(crop).toBuffer(),
    ).stats()
  ).channels;
  const visibleTint =
    after[1].mean > before[1].mean + 30 && after[2].mean > before[2].mean + 30;
  await page.evaluate(() => {
    window.__spatialTestTile.show = false;
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.spatialWorkspace.diagnostics().mode ===
      'OSM building volumes',
  );
  const fallback = await page.evaluate(() => ({
    selected: window.__godsEyeView.spatialWorkspace.diagnostics().selected,
    solids: window.__godsEyeView.viewer.dataSources
      .getByName('gev-spatial-buildings')[0]
      .entities.values.filter((e) => e.polygon).length,
  }));
  await page.evaluate(() => {
    window.__spatialTestTile.show = true;
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await page.waitForFunction(
    () =>
      window.__godsEyeView.spatialWorkspace.diagnostics().mode ===
      'Surface tint',
  );
  const modeSwitch =
    fallback.selected === 1 &&
    fallback.solids === 1 &&
    (await page.evaluate(
      () =>
        window.__godsEyeView.viewer.dataSources
          .getByName('gev-spatial-buildings')[0]
          .entities.values.filter((e) => e.polygon).length,
    )) === 0;
  const passed =
    visibleTint &&
    modeSwitch &&
    result.mode === 'Surface tint' &&
    result.solids === 0 &&
    result.masks.length === 1 &&
    result.masks[0].ready &&
    result.tileLoaded &&
    result.tileCommands > 0 &&
    !errors.length;
  await fs.writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        passed,
        fixture,
        ...result,
        visibleTint,
        modeSwitch,
        errors,
        note: 'Synthetic GLB 3D tile integration, not a Google photoreal alignment test.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, ...result, errors }));
  if (!passed) process.exitCode = 1;
} finally {
  await browser.close();
}
