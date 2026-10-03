import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import {
  type DependencyCheck,
  type LiveResponse,
  liveResponseSchema,
  type ReadyResponse,
  readyResponseSchema,
} from '@bedo/contracts';
import type { FastifyReply } from 'fastify';
import { ResponseSchema } from '../common/response-schema.js';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  /** The process is running. Never touches dependencies, so orchestrators don't restart it during an outage. */
  @Get('live')
  @ResponseSchema(liveResponseSchema)
  live(): LiveResponse {
    return { status: 'ok' };
  }

  /** The API can serve traffic: Postgres and Redis both answer within the configured timeout. */
  @Get('ready')
  @ResponseSchema(readyResponseSchema)
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadyResponse> {
    const [database, redis] = await Promise.all([
      this.check(() => this.database.ping(this.env.HEALTH_CHECK_TIMEOUT_MS)),
      this.check(() => this.redis.ping()),
    ]);
    const healthy = database.status === 'up' && redis.status === 'up';
    void reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'unavailable', checks: { database, redis } };
  }

  private async check(probe: () => Promise<void>): Promise<DependencyCheck> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), this.env.HEALTH_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([probe(), timeout]);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { status: 'down', latencyMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }
}
