import * as Cesium from 'cesium';
import { USE_COLORS } from './buildings.js';

/** Static geometry. Classification creation is lazy; no continuous-render hold. */
export function createBuildingRenderer(
  viewer,
  { onModeChange = () => {} } = {},
) {
  const source = new Cesium.CustomDataSource('gev-spatial-buildings');
  const credit = new Cesium.Credit(
    '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
    true,
  );
  let lastStyle = {},
    lastRing = null;
  let destroyed = false,
    records = [],
    tint = false;
  const entities = new Map();
  const estimateMaterials = new Map();
  function volumeMaterial(record, hex) {
    if (record.heightM !== null) return color(hex, 1);
    if (!estimateMaterials.has(hex)) {
      const base = color(hex, 1);
      estimateMaterials.set(
        hex,
        new Cesium.StripeMaterialProperty({
          evenColor: base,
          oddColor: new Cesium.Color(
            base.red * 0.74,
            base.green * 0.74,
            base.blue * 0.74,
            1,
          ),
          repeat: 18,
        }),
      );
    }
    return estimateMaterials.get(hex);
  }
  const masks = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
  const classifiers = new Map();
  let pendingColors = new Map(),
    detachPending = null;
  const attaching = Promise.resolve(viewer.dataSources.add(source));
  attaching
    .then(() => {
      if (destroyed && !viewer.isDestroyed())
        viewer.dataSources.remove(source, true);
    })
    .catch(() => {});
  const color = (hex, alpha) =>
    Cesium.Color.fromCssColorString(hex).withAlpha(alpha);
  const hasTiles = () => {
    for (let i = 0; i < viewer.scene.primitives.length; i++) {
      const p = viewer.scene.primitives.get(i);
      if (p instanceof Cesium.Cesium3DTileset && p.show) return true;
    }
    return false;
  };
  function replace(next) {
    if (destroyed) return;
    source.entities.suspendEvents();
    try {
      source.entities.removeAll();
      entities.clear();
      masks.removeAll();
      classifiers.clear();
      pendingColors.clear();
      records = next;
      tint = hasTiles();
      source.credit = source.show && records.length ? credit : undefined;
      if (detachPending) {
        detachPending();
        detachPending = null;
      }
      for (const r of records) {
        const group = [];
        if (tint) continue;
        for (const p of r.polygons) {
          const positions = Cesium.Cartesian3.fromDegreesArray(p.outer.flat());
          const holes = p.holes.map(
            (h) =>
              new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(h.flat()),
              ),
          );
          const entity = source.entities.add({
            id: `spatial:${r.id}:${group.length}`,
            name: r.name,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(positions, holes),
              stRotation: Math.PI / 4,
              height: 0,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              extrudedHeight: r.displayHeightM,
              extrudedHeightReference:
                Cesium.HeightReference.RELATIVE_TO_GROUND,
              material: volumeMaterial(r, '#61798a'),
              outline: false,
            },
          });
          entity.__gevBuildingId = r.id;
          group.push(entity);
        }
        entities.set(r.id, group);
      }
    } finally {
      source.entities.resumeEvents();
    }
    viewer.scene.requestRender();
  }
  let previous = new Map();
  function setMaskColor(mask, value) {
    if (mask.primitive.ready) {
      mask.primitive.getGeometryInstanceAttributes(mask.id).color =
        Cesium.ColorGeometryInstanceAttribute.toValue(value);
      pendingColors.delete(mask);
    } else {
      pendingColors.set(mask, value);
      if (!detachPending)
        detachPending = viewer.scene.postRender.addEventListener(() => {
          for (const [entry, desired] of pendingColors)
            if (entry.primitive.ready) setMaskColor(entry, desired);
          if (!pendingColors.size) {
            detachPending?.();
            detachPending = null;
          } else viewer.scene.requestRender();
        });
    }
  }
  function masksFor(record, value) {
    if (classifiers.has(record.id)) return classifiers.get(record.id);
    const group = [];
    for (const p of record.polygons) {
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(p.outer.flat()),
        p.holes.map(
          (h) =>
            new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(h.flat()),
            ),
        ),
      );
      let ground =
        viewer.scene.globe?.getHeight(
          Cesium.Cartographic.fromDegrees(...record.center),
        ) || 0;
      // Sample just outside the footprint so a roof does not become the base.
      if (viewer.scene.sampleHeightSupported) {
        const sample = viewer.scene.sampleHeight(
          Cesium.Cartographic.fromDegrees(
            p.outer[0][0] - 0.00003,
            p.outer[0][1] - 0.00003,
          ),
        );
        if (Number.isFinite(sample)) ground = sample;
      }
      const id = { __gevBuildingId: record.id };
      const primitive = masks.add(
        new Cesium.ClassificationPrimitive({
          geometryInstances: new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: hierarchy,
              height: ground - 3,
              extrudedHeight: ground + record.displayHeightM + 15,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(value),
            },
          }),
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        }),
      );
      group.push({ primitive, id });
    }
    classifiers.set(record.id, group);
    return group;
  }
  function style({
    ids = [],
    hover = null,
    focus = null,
    categorized = false,
  } = {}) {
    if (destroyed) return;
    lastStyle = { ids, hover, focus, categorized };
    const selected = new Set(ids),
      next = new Map();
    for (const r of records) {
      const isSelected = selected.has(r.id),
        isFocus = r.id === focus,
        isHover = r.id === hover;
      const hex = isFocus
        ? '#ffe8ad'
        : isHover
          ? '#d9faff'
          : isSelected
            ? categorized
              ? USE_COLORS[r.use]
              : '#49bfdb'
            : '#8cacc4';
      // Opaque OSM solids avoid expensive full-scene order-independent
      // transparency passes; surface classification retains texture via alpha.
      const alpha = tint ? (isFocus ? 0.9 : isHover ? 0.8 : 0.7) : 1;
      const signature = `${hex}/${alpha}/${tint && !isSelected && !isHover}`;
      next.set(r.id, signature);
      if (previous.get(r.id) === signature) continue;
      if (tint) {
        const visible = isSelected || isHover;
        for (const mask of visible
          ? masksFor(r, color(hex, alpha))
          : classifiers.get(r.id) || []) {
          mask.primitive.show = visible;
          if (visible) setMaskColor(mask, color(hex, alpha));
        }
      }
      for (const e of entities.get(r.id) || []) {
        e.show = !tint || isSelected || isHover;
        e.polygon.material = volumeMaterial(r, hex);
      }
    }
    previous = next;
    viewer.scene.requestRender();
  }
  let area = null;
  function setArea(ring) {
    lastRing = ring;
    if (!ring) {
      if (area) source.entities.remove(area);
      area = null;
    } else if (area)
      area.polyline.positions = Cesium.Cartesian3.fromDegreesArray(ring.flat());
    else
      area = source.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
          width: 3,
          material: color('#71e6ff', 0.95),
        },
      });
    viewer.scene.requestRender();
  }
  function focus(record) {
    if (!record) return;
    const ground =
      viewer.scene.globe?.getHeight(
        Cesium.Cartographic.fromDegrees(...record.center),
      ) || 0;
    // An oblique close-up can put a neighboring tower between camera and
    // subject. Inspect from above the loaded roofline, with room for context.
    const clearance =
      Math.max(250, ...records.map((r) => r.displayHeightM)) + 220;
    const altitude =
      ground + Math.max(clearance, Math.sqrt(record.footprintM2) * 4);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(...record.center, altitude),
      orientation: {
        heading: viewer.camera.heading,
        pitch: -Math.PI / 2,
        roll: 0,
      },
      maximumHeight: Math.max(
        altitude,
        viewer.camera.positionCartographic.height,
      ),
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : 0.9,
    });
  }
  const stopModeWatch = viewer.scene.preRender.addEventListener(() => {
    if (destroyed || !records.length || hasTiles() === tint) return;
    const ring = lastRing,
      styling = lastStyle;
    previous.clear();
    area = null;
    replace(records);
    setArea(ring);
    style(styling);
    onModeChange();
  });
  return {
    replace(next) {
      previous.clear();
      area = null;
      lastRing = null;
      replace(next);
    },
    style,
    setArea,
    focus,
    setVisible(value) {
      source.show = value;
      source.credit = value && records.length ? credit : undefined;
      masks.show = value;
      viewer.scene.requestRender();
    },
    get mode() {
      return tint ? 'Surface tint' : 'OSM building volumes';
    },
    destroy() {
      destroyed = true;
      stopModeWatch();
      detachPending?.();
      pendingColors.clear();
      viewer.scene.primitives.remove(masks);
      if (viewer.dataSources.contains(source))
        viewer.dataSources.remove(source, true);
      entities.clear();
      estimateMaterials.clear();
      records = [];
    },
  };
}
