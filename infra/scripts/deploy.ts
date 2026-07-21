import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFRA = path.resolve(__dirname, '..');
const REPO = path.resolve(INFRA, '..');

// Read the repo-root .env WITHOUT mutating process.env. We only need its
// CORS_ALLOWED_ORIGIN value; loading the whole file into process.env would
// leak VITE_* (local dev URLs) into the phase-2 `vite build`, and Vite gives
// pre-existing process.env vars top priority — shadowing .env.production and
// baking the local API URL into the production bundle.
const rootEnv = existsSync(path.join(REPO, '.env'))
  ? parseEnv(readFileSync(path.join(REPO, '.env'), 'utf8'))
  : {};
const OUTPUTS = path.join(INFRA, 'outputs.json');
// vite.config.ts sets `envDir: REPO_ROOT`, so `vite build` only loads .env
// files from the repo root — not from apps/web. Write the production override
// there so it takes precedence over the local URLs in the root `.env`.
const WEB_ENV_FILE = path.join(REPO, '.env.production');
const WEB_DIST = path.join(REPO, 'apps', 'web', 'dist');

const run = (cmd: string, cwd = REPO) => {
  console.info(`\n$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

/**
 * Two-phase deploy:
 * 1. cdk deploy produces API URLs (frontend build not yet uploaded).
 * 2. Write those URLs into the repo-root .env.production, build the frontend.
 * 3. cdk deploy again — BucketDeployment now finds dist/ and uploads.
 */
const main = () => {
  console.info('Phase 1: provisioning AWS resources');
  run(`cdk deploy --outputs-file ${OUTPUTS} --require-approval never`, INFRA);

  if (!existsSync(OUTPUTS)) throw new Error('CDK did not produce outputs.json');
  const outputs = JSON.parse(readFileSync(OUTPUTS, 'utf8')) as Record<
    string,
    Record<string, string>
  >;
  const stackOutputs = outputs.BlogAssistantStack ?? {};
  const apiUrl = stackOutputs.ApiUrl;
  const chatUrl = stackOutputs.ChatUrl;
  const siteUrl = stackOutputs.SiteUrl;
  if (!apiUrl || !chatUrl) throw new Error('Missing ApiUrl or ChatUrl in outputs');
  if (!siteUrl) throw new Error('Missing SiteUrl in outputs');

  console.info(`\nApiUrl:  ${apiUrl}`);
  console.info(`ChatUrl: ${chatUrl}`);
  console.info(`SiteUrl: ${siteUrl}`);

  process.env.CORS_ALLOWED_ORIGIN = siteUrl;
  console.info(`CORS_ALLOWED_ORIGIN: ${siteUrl}`);

  mkdirSync(path.dirname(WEB_ENV_FILE), { recursive: true });
  writeFileSync(
    WEB_ENV_FILE,
    `VITE_API_URL=${apiUrl}\nVITE_CHAT_URL=${chatUrl}\n`,
    'utf8',
  );
  console.info(`Wrote ${WEB_ENV_FILE}`);

  console.info('\nPhase 2: building frontend');
  run(`pnpm --filter @blog/web build`);

  if (!existsSync(WEB_DIST)) throw new Error('Frontend build produced no dist/');

  console.info('\nPhase 3: uploading frontend to S3 + CloudFront');
  run(`cdk deploy --require-approval never`, INFRA);

  console.info('\nDone.');
  console.info(`Site:     ${stackOutputs.SiteUrl}`);
  console.info(`API:      ${apiUrl}`);
  console.info(`Chat:     ${chatUrl}`);
  console.info(
    '\nCreate MongoDB indexes once (same MONGODB_URI as in .env / SSM):\n  pnpm --filter @blog/api migrate',
  );
};

main();
