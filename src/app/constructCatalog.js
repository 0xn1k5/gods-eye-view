import { createLayerCatalog } from './catalog.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createApplicationFlights } from './layers/flights.js';
import { createApplicationMilitary } from './layers/militaryFlights.js';
import { createApplicationVessels } from './layers/aisLiveVessels.js';
import { createApplicationCctv } from './layers/cctv.js';
import { createApplicationRadio } from './layers/radio.js';
import { createApplicationTraffic } from './layers/traffic.js';
import { createApplicationBikeshare } from './layers/bikeshare.js';
import { createApplicationInstallations } from './layers/militaryInstallations.js';
import { createApplicationSatellites } from './layers/satellites.js';
import { createApplicationLaunches } from './layers/rocketLaunches.js';
import { createApplicationAlpr } from './layers/alprCameras.js';
import { createApplicationAwareness } from './layers/militaryAwareness.js';
import { createApplicationFirms } from './layers/firms.js';
import { createApplicationEarthquakes } from './layers/earthquakes.js';
import { createApplicationCables } from './layers/submarineCables.js';
import { createInfrastructureLayers } from '../data/infrastructure.js';
import { localGeoJsonServices } from '../data/localGeojson.js';

const SOURCE_METHODS = Object.freeze({
  flights: ['getSnapshot'],
  military: ['getSnapshot'],
  vessels: ['getSnapshot'],
  cctv: ['getCatalog', 'getHealth', 'getFrameUrl', 'getMediaUrl'],
  radio: ['getDirectory', 'recordClick'],
  traffic: [
    'requestRoads',
    'getStatus',
    'fetchFlowForBounds',
    'getFlowSessionStats',
    'resetFlowTileCache',
  ],
  bikeshare: ['getStations'],
  installations: ['getMappedSites', 'searchNearby'],
  satellites: ['readGroup'],
  launches: ['getLaunches', 'getActiveTle'],
  alpr: ['fetch'],
  firms: ['getSnapshot'],
  earthquakes: ['getSnapshot'],
  cables: ['fetch'],
});

/** Construct the current catalog without choosing any source provider.
 * Scene engines remain page-owned; layers and classification have this app's lifetime.
 * The manager owns layer destruction, while abort releases classification even if startup fails.
 */
export function createApplicationCatalog({
  sources,
  signal,
  metadata = LAYER_STATE_REGISTRY,
  vesselOptions,
  resolveAsset,
}) {
  if (!signal?.addEventListener)
    throw new TypeError('An application lifetime signal is required');
  signal.throwIfAborted();
  for (const [name, methods] of Object.entries(SOURCE_METHODS)) {
    if (
      methods.some((method) => typeof sources?.[name]?.[method] !== 'function')
    )
      throw new TypeError(`Invalid catalog source: ${name}`);
  }
  const militaryRegistry = createMilitaryRegistry();
  const dispose = () => {
    signal.removeEventListener('abort', dispose);
    militaryRegistry.dispose();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    militaryRegistry.configureSource(sources.military, { signal });
    const flights = createApplicationFlights({
      source: sources.flights,
      militaryRegistry,
      resolveAsset,
    });
    const military = createApplicationMilitary({
      source: sources.military,
      militaryRegistry,
      resolveAsset,
    });
    const vessels = createApplicationVessels({
      source: sources.vessels,
      options: vesselOptions,
    });
    const installations = createApplicationInstallations({
      source: sources.installations,
    });
    const satellites = createApplicationSatellites({
      source: sources.satellites,
    });
    const catalog = createLayerCatalog(
      [
        flights,
        military,
        createApplicationEarthquakes({ source: sources.earthquakes }),
        createApplicationAlpr({ source: sources.alpr }),
        satellites,
        createApplicationLaunches({ source: sources.launches, satellites }),
        createApplicationTraffic({ source: sources.traffic }),
        createApplicationCctv({ source: sources.cctv }),
        createApplicationRadio({ source: sources.radio }),
        createApplicationBikeshare({ source: sources.bikeshare }),
        vessels,
        installations,
        createApplicationAwareness({
          flights,
          military,
          vessels,
          installations,
        }),
        ...createInfrastructureLayers(localGeoJsonServices),
        createApplicationCables({ source: sources.cables }),
        createApplicationFirms({
          id: 'local-firms',
          name: 'FIRMS Active Fires',
          icon: '▲',
          source: 'NASA FIRMS · LIVE',
          feed: sources.firms,
        }),
      ],
      metadata,
    );
    return Object.freeze({ ...catalog, militaryRegistry });
  } catch (error) {
    dispose();
    throw error;
  }
}
