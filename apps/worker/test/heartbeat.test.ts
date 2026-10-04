import { loadEnv, workerEnvSchema } from '@bedo/config';
import { workerHeartbeatKey } from '@bedo/contracts';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { HeartbeatProcessor } from '../src/system/heartbeat.processor.js';

describe('HeartbeatProcessor', () => {
  it('stores the run time with a TTL of three intervals', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const env = loadEnv(workerEnvSchema, { REDIS_URL: 'redis://localhost:6379', DATABASE_URL: 'postgresql://u:p@localhost:5432/x', OTP_DELIVERY: 'test-capture', NODE_ENV: 'test', WORKER_HEARTBEAT_INTERVAL_MS: '15000', QUEUE_PREFIX: 'bedo-staging' });
    const processor = new HeartbeatProcessor(env, { set } as unknown as Redis);
    const now = new Date('2026-10-04T10:00:00.000Z');
    await processor.process(now);
    expect(workerHeartbeatKey('bedo-staging')).toBe('bedo-staging:worker:heartbeat');
    expect(set).toHaveBeenCalledWith(workerHeartbeatKey('bedo-staging'), '2026-10-04T10:00:00.000Z', 'EX', 45);
  });
});
