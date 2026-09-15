import * as Cesium from 'cesium';
import { createRailwaysLayer } from '../../layers/railways/index.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { overlayHost } from './overlayHost.js';

/** Wire live Indian Railways observations to the application overlay host + context store. */
export function createApplicationRailways(options) {
  return createRailwaysLayer({
    overlayHost,
    services: {
      context,
      picking,
      overlays,
    },
    screenSpaceEventHandlerFactory:
      options.screenSpaceEventHandlerFactory ??
      ((viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)),
    ...options,
  });
}
