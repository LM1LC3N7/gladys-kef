// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the KefApp of src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { KefApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new KefApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.stop());

logger.info('Starting the KEF integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
