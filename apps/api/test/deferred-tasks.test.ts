import { describe, expect, it } from 'vitest';
import { DeferredTasks } from '../src/runtime/deferred-tasks.service.js';

/** D-36: work after the response, kept alive by the platform (Next.js after(), Netlify waitUntil). */
describe('DeferredTasks', () => {
  it('collects work deferred during a request and runs it only after the handler has answered', async () => {
    const tasks = new DeferredTasks();
    const order: string[] = [];
    const { result, background } = await tasks.runRequest(async () => {
      tasks.defer('one', async () => void order.push('task one'));
      tasks.defer('two', async () => {
        order.push('task two');
        // Work deferred by deferred work runs in the same background promise.
        tasks.defer('three', async () => void order.push('task three'));
      });
      order.push('response');
      return 'answer';
    });
    expect(result).toBe('answer');
    expect(order).toEqual(['response']);
    await background!();
    expect(order).toEqual(['response', 'task one', 'task two', 'task three']);
  });

  it('keeps requests apart, survives a failing task, and reports no work when there is none', async () => {
    const tasks = new DeferredTasks();
    const seen: string[] = [];
    const [a, b] = await Promise.all([
      tasks.runRequest(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        tasks.defer('a', async () => void seen.push('a'));
      }),
      tasks.runRequest(async () => {
        tasks.defer('fails', async () => {
          throw new Error('boom');
        });
        tasks.defer('b', async () => void seen.push('b'));
      }),
    ]);
    await Promise.all([a.background!(), b.background!()]);
    expect(seen.sort()).toEqual(['a', 'b']);
    expect((await tasks.runRequest(async () => 1)).background).toBeNull();
  });

  it('outside a request, starts the work at once and lets callers wait for it', async () => {
    const tasks = new DeferredTasks();
    let done = false;
    tasks.defer('now', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = true;
    });
    expect(done).toBe(false);
    await tasks.drain();
    expect(done).toBe(true);
  });
});
