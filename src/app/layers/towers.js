import * as Cesium from 'cesium';
import { createTowersLayer } from '../../layers/towers/index.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { overlayHost } from './overlayHost.js';

/** Wire cell-tower observations to the application overlay host + context store. */
export function createApplicationTowers(options) {
  return createTowersLayer({
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
