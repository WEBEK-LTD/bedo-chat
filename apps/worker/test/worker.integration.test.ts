import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { loadEnv, workerEnvSchema } from '@bedo/config';
import { QUEUE_NAMES, workerHeartbeatKey } from '@bedo/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerModule } from '../src/worker.module.js';

const redisUrl = process.env.REDIS_URL;
// A unique prefix keeps this test away from any real queue on the same Redis.
const prefix = `bedo-test-${randomBytes(4).toString('hex')}`;
const heartbeatKey = workerHeartbeatKey(prefix);

describe.runIf(redisUrl)('worker against real Redis', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    await redis.del(heartbeatKey);
  });

  afterAll(async () => {
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    for (const name of [QUEUE_NAMES.system, QUEUE_NAMES.otp, QUEUE_NAMES.push, QUEUE_NAMES.maintenance]) {
      const queue = new Queue(name, { connection, prefix });
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await connection.quit();
    await redis.del(heartbeatKey);
    await redis.quit();
  });

  it('registers the heartbeat schedule and processes it', async () => {
    const env = loadEnv(workerEnvSchema, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: redisUrl!,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
      OTP_DELIVERY: 'test-capture',
      SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
      WORKER_HEARTBEAT_INTERVAL_MS: '1000',
      QUEUE_PREFIX: prefix,
    });
    const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { logger: false });
    await app.init();
    try {
      let value: string | null = null;
      for (let attempt = 0; attempt < 50 && value === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        value = await redis.get(heartbeatKey);
      }
      expect(value).not.toBeNull();
      expect(Date.now() - Date.parse(value!)).toBeLessThan(10_000);
      expect(await redis.ttl(heartbeatKey)).toBeGreaterThan(0);

      const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      const queue = new Queue(QUEUE_NAMES.system, { connection, prefix });
      const schedulers = await queue.getJobSchedulers();
      await queue.close();
      await connection.quit();
      expect(schedulers.map((scheduler) => scheduler.key)).toContain('heartbeat');
    } finally {
      await app.close();
    }

    // Every connection the worker opened is closed on shutdown.
    const clients = await redis.client('LIST');
    expect(String(clients)).not.toMatch(/name=bedo-worker/);
  });
});
