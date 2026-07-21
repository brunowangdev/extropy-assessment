import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads .env from the monorepo root. Called for its side effects by entry
 * points (dev-server, migrate scripts). Skipped silently if the file doesn't
 * exist — Lambda gets env from the runtime and never reads a .env file.
 *
 * This file sits at apps/api/src/lib/load-env.ts, so the repo root is 4 dirs up.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '..', '..', '..', '..', '.env');

loadEnv({ path: ENV_PATH });
