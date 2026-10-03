import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv, workerEnvSchema } from '@bedo/config';
import { buildLogger } from './logger.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv(workerEnvSchema);
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { logger: buildLogger(env) });
  app.enableShutdownHooks();
  new Logger('Bootstrap').log('Bedo Chat worker started');
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
