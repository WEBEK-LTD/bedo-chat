import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { createUser, type TestUser } from './messaging-helpers.js';

/**
 * Phase 13 (D-46) load test, at the academy's size and above. Opt-in (LOAD_TEST=1) because it takes a few minutes;
 * LOAD_TEST_OUT=<file> saves the numbers as JSON. Several API instances share one Postgres, as Netlify runs several
 * function instances, each with its small connection pool (DATABASE_POOL_MAX, 3). Requests go to the instances in
 * turn, many at once. Numbers are from this machine with the database next to the API: production adds the
 * network between Netlify and Supabase (both in Sydney) to every request.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL) && process.env.LOAD_TEST === '1';

const INSTANCES = 6;
const STUDENTS = 200;
const GROUP_SIZE = 10;
const MESSAGES_EACH = 10;
const CONCURRENCY = 50;
const SUBSCRIBERS = 1000;

interface Timing {
  count: number;
  failed: number;
  p50: number;
  p95: number;
  max: number;
  perSecond: number;
}

function summarize(durations: number[], failed: number, wallMs: number): Timing {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (share: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0);
  return { count: durations.length, failed, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0), perSecond: Math.round((durations.length / wallMs) * 1000) };
}

/** Runs the jobs with at most `limit` at a time; returns each job's time in ms and how many failed. */
async function run(jobs: Array<() => Promise<boolean>>, limit: number): Promise<Timing> {
  const durations: number[] = [];
  let failed = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const t0 = performance.now();
        const ok = await job().catch(() => false);
        durations.push(performance.now() - t0);
        if (!ok) failed += 1;
      }
    }),
  );
  return summarize(durations, failed, performance.now() - started);
}

describe.runIf(enabled)('Phase 13 load test (real Postgres, several API instances)', () => {
  let ctx: IntegrationEnv;
  const apps: NestFastifyApplication[] = [];
  let turn = 0;
  const results: Record<string, unknown> = {};

  /** One request on the next instance. */
  async function call(user: TestUser, method: 'GET' | 'POST', url: string, payload?: object) {
    const app = apps[turn++ % apps.length]!;
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${user.token}` }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    for (let index = 0; index < INSTANCES; index += 1) apps.push(await startApp(ctx.env));
  }, 120_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    await ctx?.teardown();
    if (process.env.LOAD_TEST_OUT) writeFileSync(process.env.LOAD_TEST_OUT, JSON.stringify(results, null, 2));
    // eslint-disable-next-line no-console -- the numbers are the point of this opt-in test
    console.log(JSON.stringify(results, null, 2));
  });

  it(`${STUDENTS} students in groups of ${GROUP_SIZE} send ${MESSAGES_EACH} messages each, ${CONCURRENCY} at a time`, async () => {
    const students: TestUser[] = [];
    for (let index = 0; index < STUDENTS; index += 1) students.push(await createUser(ctx, apps[index % apps.length]!, `Student ${index + 1}`));
    // The message limit is per minute; this test is about throughput, not the limit.
    await query(ctx.ownerUrl, `delete from app.rate_counters where key like 'rl:%'`);
    const groups: Array<{ id: string; members: TestUser[] }> = [];
    for (let start = 0; start < STUDENTS; start += GROUP_SIZE) {
      const members = students.slice(start, start + GROUP_SIZE);
      const created = await call(members[0]!, 'POST', '/v1/groups', { title: `Class ${start / GROUP_SIZE + 1}`, memberIds: members.slice(1).map((member) => member.id) });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      groups.push({ id: created.body.id, members });
    }

    const jobs: Array<() => Promise<boolean>> = [];
    for (let round = 0; round < MESSAGES_EACH; round += 1) {
      for (const group of groups) {
        for (const member of group.members) {
          jobs.push(async () => (await call(member, 'POST', `/v1/chats/${group.id}/messages`, { clientId: randomUUID(), text: `Message ${round} from ${member.name} about the homework` })).status === 200);
        }
      }
    }
    results.sendGroupMessage = await run(jobs, CONCURRENCY);
    await ctx.settle();
    const sent = (await query<{ n: number }>(ctx.ownerUrl, `select count(*)::int as n from app.messages`)).rows[0]!.n;
    results.messagesStored = sent;

    // Every student opens the app: chat list, then catches up from the start.
    results.chatList = await run(students.map((student) => async () => (await call(student, 'GET', '/v1/chats')).status === 200), CONCURRENCY);
    results.syncFromStart = await run(students.map((student) => async () => (await call(student, 'GET', '/v1/sync?since=0')).status === 200), CONCURRENCY);
    results.openGroupHistory = await run(
      groups.flatMap((group) => group.members.map((member) => async () => (await call(member, 'GET', `/v1/chats/${group.id}/messages`)).status === 200)),
      CONCURRENCY,
    );
    results.searchEverywhere = await run(students.slice(0, 100).map((student) => async () => (await call(student, 'GET', '/v1/search?q=homework')).status === 200), CONCURRENCY);
    results.heartbeat = await run(students.map((student) => async () => (await call(student, 'POST', '/v1/realtime/heartbeat')).status === 200), CONCURRENCY);

    expect((results.sendGroupMessage as Timing).failed).toBe(0);
    expect(sent).toBeGreaterThanOrEqual(STUDENTS * MESSAGES_EACH);
    for (const key of ['chatList', 'syncFromStart', 'openGroupHistory', 'searchEverywhere', 'heartbeat']) expect((results[key] as Timing).failed, key).toBe(0);

    // A channel post to every subscriber.
    const owner = students[0]!;
    await query(ctx.ownerUrl, `insert into app.user_permissions (user_id, create_channels) values ($1, true) on conflict (user_id) do update set create_channels = true`, [owner.id]);
    const channel = await call(owner, 'POST', '/v1/channels', { title: 'Academy news', isPublic: false });
    expect(channel.status, JSON.stringify(channel.body)).toBe(200);
    await query(
      ctx.ownerUrl,
      `with u as (
         insert into app.users (phone, name) select '+2019' || lpad(g::text, 8, '0'), 'Subscriber ' || g from generate_series(1, $2::int) g returning id
       )
       insert into app.conversation_members (conversation_id, user_id, role) select $1::uuid, u.id, 'subscriber' from u`,
      [channel.body.id, SUBSCRIBERS],
    );
    const posts: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const t0 = performance.now();
      const post = await call(owner, 'POST', `/v1/chats/${channel.body.id}/messages`, { clientId: randomUUID(), text: `Announcement ${index}` });
      expect(post.status, JSON.stringify(post.body)).toBe(200);
      posts.push(performance.now() - t0);
    }
    const fanOutStart = performance.now();
    await ctx.settle();
    results.channelPostTo1000 = { ...summarize(posts, 0, posts.reduce((a, b) => a + b, 0)), backgroundWorkAfterMs: Math.round(performance.now() - fanOutStart) };
  }, 900_000);
});
