import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { apiEnvSchema, loadEnv } from '@bedo/config';
import { createApp } from './app.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv(apiEnvSchema);
  const app = await createApp(env);
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  new Logger('Bootstrap').log(`Bedo Chat API listening on ${env.API_HOST}:${env.API_PORT}`);
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
