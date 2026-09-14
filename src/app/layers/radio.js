import { createRadioLayer } from '../../layers/radio/index.js';
import * as ground from '../../data/groundFloor.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as globe from '../../celestialRing.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationRadio({ source }) {
  return createRadioLayer({
    source,
    services: { ground, picking, overlays, globe, render },
  });
}
