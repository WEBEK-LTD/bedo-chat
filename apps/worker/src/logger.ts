import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';

const NEST_LOG_LEVELS: Record<Exclude<WorkerEnv['LOG_LEVEL'], 'silent'>, LogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

/** JSON lines in production (for log collectors), readable text in development. */
export function buildLogger(env: Pick<WorkerEnv, 'LOG_LEVEL' | 'NODE_ENV'>): ConsoleLogger | false {
  if (env.LOG_LEVEL === 'silent') {
    return false;
  }
  const production = env.NODE_ENV === 'production';
  return new ConsoleLogger({ json: production, colors: !production, logLevels: NEST_LOG_LEVELS[env.LOG_LEVEL] });
}
