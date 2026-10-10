import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, Logger } from '@nestjs/common';

type Task = { label: string; run: () => Promise<unknown> };

interface RequestScope {
  tasks: Task[];
}

const scopes = new AsyncLocalStorage<RequestScope>();

/**
 * Work that must not hold up the response (D-36): sending a one-time code through Waabek, Web Push
 * notifications, realtime signals and housekeeping. On the website's server functions there is no process
 * that outlives a request, so this work runs right after the response within the same invocation
 * (Next.js after(), which Netlify keeps alive with waitUntil): see runRequest().
 *
 * Outside a request (tests, scripts) a task starts at once in the background; drain() waits for all of them.
 */
@Injectable()
export class DeferredTasks {
  private readonly logger = new Logger(DeferredTasks.name);
  private readonly running = new Set<Promise<void>>();

  defer(label: string, run: () => Promise<unknown>): void {
    const scope = scopes.getStore();
    if (scope) {
      scope.tasks.push({ label, run });
      return;
    }
    this.track(this.execute({ label, run }));
  }

  /** Waits until every task started outside a request has finished (tests). */
  async drain(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
  }

  /**
   * Runs `handler` collecting the tasks it defers. Returns its result and, when work was deferred, a function
   * that runs that work; the caller starts it once the response is on its way (Next.js after(), which Netlify
   * keeps alive with waitUntil). Tasks that defer further tasks are handled in the same run.
   */
  async runRequest<T>(handler: () => Promise<T>): Promise<{ result: T; background: (() => Promise<void>) | null }> {
    const scope: RequestScope = { tasks: [] };
    const result = await scopes.run(scope, handler);
    if (scope.tasks.length === 0) {
      return { result, background: null };
    }
    let started: Promise<void> | null = null;
    const background = () => {
      started ??= scopes.run(scope, async () => {
        while (scope.tasks.length > 0) {
          const batch = scope.tasks.splice(0);
          await Promise.all(batch.map((task) => this.execute(task)));
        }
      });
      this.track(started);
      return started;
    };
    return { result, background };
  }

  private async execute(task: Task): Promise<void> {
    try {
      await task.run();
    } catch (error) {
      this.logger.error(`Background task "${task.label}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private track(promise: Promise<void>): void {
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise));
  }
}
