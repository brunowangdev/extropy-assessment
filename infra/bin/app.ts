import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

// dynamic imports after env is loaded so stack construction sees process.env values
const { App } = await import('aws-cdk-lib');
const { BlogAssistantStack } = await import('../lib/stack.js');

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
new BlogAssistantStack(app, 'BlogAssistantStack', {
  env: {
    ...(account ? { account } : {}),
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
  description: 'Blog platform + AI chat assistant (Extropy assessment)',
});
