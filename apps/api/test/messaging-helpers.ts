import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { clearCooldown, type IntegrationEnv, latestCode, query } from './integration-env.js';

let phoneCounter = 0;
let ipCounter = 0;

/** A unique valid Egyptian mobile number per call (the academy list only accepts real numbers). */
export const nextPhone = () => `+2010${String(Date.now() % 1e4).padStart(4, '0')}${String(++phoneCounter).padStart(4, '0')}`;
export const nextIp = () => `10.93.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

export interface TestUser {
  id: string;
  phone: string;
  token: string;
  sessionId: string;
  name: string;
}

/** Signs a new academy number in through the real OTP flow and gives it a name. */
export async function createUser(ctx: IntegrationEnv, app: NestFastifyApplication, name: string, extraHeaders: Record<string, string> = {}): Promise<TestUser> {
  const phone = nextPhone();
  await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
  await clearCooldown(ctx.redis, ctx.prefix, phone);
  const ip = nextIp();
  await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: ip, headers: extraHeaders });
  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { phone, code: await latestCode(ctx.otpQueue, phone) },
    remoteAddress: ip,
    headers: extraHeaders,
  });
  const body = verified.json() as { accessToken: string; user: { id: string } };
  if (!body.accessToken) {
    throw new Error(`sign-in failed: ${verified.body}`);
  }
  await app.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${body.accessToken}`, ...extraHeaders }, payload: { name } });
  const session = await query<{ id: string }>(ctx.ownerUrl, 'select id from app.sessions where user_id = $1 order by created_at desc limit 1', [body.user.id]);
  return { id: body.user.id, phone, token: body.accessToken, sessionId: session.rows[0]!.id, name };
}

/** Small typed wrapper around app.inject for a signed-in user. */
export function client(app: NestFastifyApplication, user: TestUser, extraHeaders: Record<string, string> = {}) {
  const headers = { authorization: `Bearer ${user.token}`, ...extraHeaders };
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload),
    del: (url: string, payload?: unknown) => call('DELETE', url, payload),
    openChat: async (other: TestUser) => (await call('POST', '/v1/chats', { userId: other.id })).body,
    send: async (chatId: string, text: string, extra: Record<string, unknown> = {}) =>
      call('POST', `/v1/chats/${chatId}/messages`, { clientId: randomUUID(), text, ...extra }),
  };
}

/** Clears a user's message rate-limit window (tests send many messages). */
export async function resetMessageLimit(ctx: IntegrationEnv, userId: string): Promise<void> {
  await ctx.redis.del(`${ctx.prefix}:rl:messages:${userId}`);
}
