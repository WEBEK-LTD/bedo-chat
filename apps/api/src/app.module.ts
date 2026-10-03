import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import type { ApiEnv } from '@bedo/config';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { ResponseSchemaInterceptor } from './common/response-schema.js';
import { API_ENV } from './config/tokens.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, RedisModule, HealthModule],
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseSchemaInterceptor },
      ],
      exports: [API_ENV],
    };
  }
}
