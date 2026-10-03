import { z } from 'zod';

/**
 * Background queues shared by the API (producer) and the worker (consumer).
 * Feature queues are added in the phase that introduces the feature.
 */
export const QUEUE_NAMES = {
  system: 'system',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOB_NAMES = {
  heartbeat: 'heartbeat',
} as const;

export const heartbeatJobDataSchema = z.object({}).strict();
export type HeartbeatJobData = z.infer<typeof heartbeatJobDataSchema>;

/** Redis key the worker refreshes on every heartbeat job; scoped by QUEUE_PREFIX like the queues. */
export function workerHeartbeatKey(queuePrefix: string): string {
  return `${queuePrefix}:worker:heartbeat`;
}
