# Spatial conversations

**Ask the world** turns a selection of mapped buildings into an explicit question context. The workspace combines direct map interaction, dimensional highlights, calculated answers and an optional model explanation.

## Try it

1. Open **Ask the world · 3D** and choose **Load buildings here** over a neighborhood.
2. Click a building, Shift-click another to compare, or choose **Draw area** and drag an outline. You can also click corners and choose **Finish**.
3. Ask **What’s here?**, **Color by use**, **Which is tallest?**, or **How far apart are these?** for a pair.
4. Ask a free-form question to explain the supplied evidence. This uses the server’s OpenAI key; calculated questions work without a key.
5. Expand **Inspect evidence** for source records and a camera focus button.

Selection stays in world coordinates during navigation. Changing it marks the previous answer as stale. A late answer cannot replace the answer for a newer selection. Closing the workspace releases its pointer ownership and hides its geometry.

## What the map means

- **Solid volume:** an OSM height tag is present. This is a recorded value, not a surveyed or current-height guarantee.
- **Hatched volume:** display height is estimated from recorded floor count or a 12 m display fallback. It is excluded from recorded-height ranking.
- **Colors:** recorded building-use categories. Grey means no recognized use category; it does not imply vacant or inactive.
- **Area:** approximate horizontal footprint area, excluding mapped courtyards. It is not floor area.
- **Pair distance:** approximate horizontal straight-line distance between footprint bounding-box centers. It is not a walking route, entrance distance or structural clearance.
- **Inclusion:** choose buildings touching the drawn area or fully inside it. Only loaded records participate.

## Rendering

With an imagery/terrain map, the workspace extrudes real OSM footprint polygons relative to ground. With a visible Cesium 3D tileset, it uses explicit `ClassificationPrimitive` volumes to tint existing surfaces. It does not add a second opaque building mesh over the tiles. Selection survives switches between these modes.

Classification depends on footprint alignment, terrain/mesh elevation and the vertical extent of the classification volume. Photogrammetry can disagree with OSM geometry. The synthetic 3D tile integration test verifies the rendering mechanism; it cannot establish alignment for every external tileset. Satellite photography can also contain displaced roof imagery and baked shadows beneath the OSM solids.

## Data and service limits

- A request covers a 600 m neighborhood, with at most 500 rendered building records. The UI labels truncation and source timestamps.
- The interactive query requests OSM ways. Complex relation buildings may be missing; the parser can handle complete relations supplied by a future indexed source.
- Public Overpass availability and cold-load latency vary. The existing proxy caches and coalesces requests. Failed loads retain the previous selection.
- The model receives bounded, whitelisted fields and server-recomputed aggregates. It is instructed to use the supplied evidence, distinguish unknown heights, and identify unsupported questions. It does not search the web or infer occupants, ownership, safety or current activity from imagery.
- API credentials stay on the existing local server. `OPENAI_SPATIAL_MODEL` optionally overrides the default `gpt-5-mini` Responses model. Model requests use `store: false`.
- Voice can read the active building context and invoke use/recorded-height answers through `spatial_selection`. Microphone/audio behavior requires an actual voice session.

## Implementation

| Component | Responsibility |
| --- | --- |
| `src/spatial/buildings.js` | Bounded parsing, footprints, intersections, provenance and calculated facts |
| `src/spatial/renderer.js` | Ground-relative volumes, estimated-height hatching, tile classification and safe evidence focus |
| `src/spatial/workspace.js` | Pointer ownership, drawing, selection, evidence, request revisions and UI lifecycle |
| `src/sources/spatialBuildings.js` | Bounded source request through the existing Overpass proxy |
| `server/providers/openai/spatial-answer.js` | Request validation, normalized evidence and grounded model explanation |

No continuous render hold is added. Geometry and material work is bounded, unchanged colors are skipped, evidence rendering stops at 60 DOM rows, and request/selection metrics retain only recent samples.

## Verification

Use the installed Node runtime, or this checkout’s `scripts/local-env.sh` wrapper:

```sh
npm test
npm run build
npm run format:check
npm run check:boundaries
node --test src/spatial/*.test.mjs src/voice/gevActions.test.mjs
```

Browser tests require the app running at localhost:4173:

```sh
node scripts/qa-spatial-workspace.mjs
node scripts/qa-spatial-tiles.mjs
```

The first test uses live OSM by default. For repeatable interaction tests, `QA_OSM_FIXTURE` can name an actual saved Overpass response. This replays only the building fetch; imagery/terrain networking remains normal. `QA_MODEL=1` exercises the live answer service. `QA_RECORD=1` records two clips using a local ffmpeg installation. Test artifacts clearly distinguish replayed source data, synthetic tiles and live model calls.

`scripts/benchmark-spatial-render.mjs` compares a warm orbit with and without the overlay in system Chrome on a local Mac. Its results describe that environment, not a guarantee for every device. `scripts/review-spatial-gemini.mjs` sends explicitly named review artifacts to Gemini 3.8 Flash; do not include secrets or unrelated files.
