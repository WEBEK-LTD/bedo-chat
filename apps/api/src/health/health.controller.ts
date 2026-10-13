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

@Controller('health')
export class HealthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** The process is running. Never touches dependencies, so orchestrators don't restart it during an outage. */
  @Get('live')
  @ResponseSchema(liveResponseSchema)
  live(): LiveResponse {
    return { status: 'ok' };
  }

  /** The API can serve traffic: Postgres answers within the configured timeout (D-36: the only dependency). */
  @Get('ready')
  @ResponseSchema(readyResponseSchema)
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadyResponse> {
    const database = await this.check(() => this.database.ping(this.env.HEALTH_CHECK_TIMEOUT_MS));
    const healthy = database.status === 'up';
    void reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'unavailable', checks: { database } };
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
