import { createApplicationData } from '../app/data.js';
import { createStandaloneCatalog } from './catalog.js';
export function createStandaloneData(options) {
  return createApplicationData({
    catalog: createStandaloneCatalog(),
    ...options,
  });
}
