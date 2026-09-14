import { createInstallationsLayer } from '../../layers/installations/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as ground from '../../data/groundFloor.js';
import * as anchors from '../../data/fireAnchors.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationInstallations({ source }) {
  return createInstallationsLayer({
    source,
    services: { render, context, ground, anchors, picking },
  });
}
