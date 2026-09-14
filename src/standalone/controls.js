import { createApplicationControls } from '../app/controls.js';
import { createStandaloneCatalog } from './catalog.js';
export function createStandaloneControls(options) {
  return createApplicationControls({
    catalog: createStandaloneCatalog(),
    ...options,
  });
}
