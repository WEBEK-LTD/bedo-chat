import { z } from 'zod';

export const liveResponseSchema = z.object({
  status: z.literal('ok'),
});
export type LiveResponse = z.infer<typeof liveResponseSchema>;

export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: dependencyCheckSchema,
  }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
