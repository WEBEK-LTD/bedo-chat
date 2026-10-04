import { isIPv4, isIPv6 } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from './redis.service.js';

/**
 * Atomic gate for sending a one-time code. In one Redis script it enforces:
 * the resend cooldown for the number, the per-number hourly limit and the per-IP hourly limit
 * (sliding windows), and only records the attempt if all three allow it.
 */
const OTP_GATE_SCRIPT = `
local phoneKey, ipKey, cooldownKey = KEYS[1], KEYS[2], KEYS[3]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local phoneLimit = tonumber(ARGV[3])
local ipLimit = tonumber(ARGV[4])
local cooldownMs = tonumber(ARGV[5])
local member = ARGV[6]
redis.call('ZREMRANGEBYSCORE', phoneKey, 0, now - windowMs)
redis.call('ZREMRANGEBYSCORE', ipKey, 0, now - windowMs)
local cooldown = redis.call('PTTL', cooldownKey)
if cooldown > 0 then return {0, cooldown, 1} end
if redis.call('ZCARD', phoneKey) >= phoneLimit then
  local oldest = redis.call('ZRANGE', phoneKey, 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + windowMs - now, 2}
end
if redis.call('ZCARD', ipKey) >= ipLimit then
  local oldest = redis.call('ZRANGE', ipKey, 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + windowMs - now, 3}
end
redis.call('ZADD', phoneKey, now, member)
redis.call('ZADD', ipKey, now, member)
redis.call('PEXPIRE', phoneKey, windowMs)
redis.call('PEXPIRE', ipKey, windowMs)
redis.call('SET', cooldownKey, '1', 'PX', cooldownMs)
return {1, 0, 0}
`;

/** Counts one attempt atomically and returns the new count; the window starts with the first attempt. */
const RESERVE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

/**
 * The address a per-IP limit counts against. IPv6 clients usually control a whole /64, so every address in
 * it shares one budget; IPv4-mapped IPv6 addresses count as their IPv4 address.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) {
    return mapped[1];
  }
  if (!isIPv6(ip)) {
    return ip;
  }
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]!.split('::') as [string, string?];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups] : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export type OtpGateResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: 'cooldown' | 'phone_limit' | 'ip_limit' };

export interface OtpGateLimits {
  perPhonePerHour: number;
  perIpPerHour: number;
  cooldownSeconds: number;
}

@Injectable()
export class RateLimitService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * Reserve-first attempt counter: the attempt is counted before the (slow) check runs, so parallel
   * requests cannot all see the same old count. Callers refuse when `count` exceeds their limit.
   */
  async reserveAttempt(key: string, windowMs: number): Promise<{ count: number; retryAfterSeconds: number }> {
    const [count, ttl] = (await this.redis.client.eval(RESERVE_SCRIPT, 1, key, String(windowMs))) as [number, number];
    return { count, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
  }

  async otpGate(scope: string, phone: string, ip: string, limits: OtpGateLimits): Promise<OtpGateResult> {
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2)}`;
    const result = (await this.redis.client.eval(
      OTP_GATE_SCRIPT,
      3,
      `${this.redis.prefix}:rl:${scope}:phone:${phone}`,
      // One per-IP budget for every kind of code (sign-in, phone change, admin): 20 per hour in total.
      `${this.redis.prefix}:rl:otp-ip:${ipBucket(ip)}`,
      `${this.redis.prefix}:rl:${scope}:cooldown:${phone}`,
      String(now),
      String(60 * 60 * 1000),
      String(limits.perPhonePerHour),
      String(limits.perIpPerHour),
      String(limits.cooldownSeconds * 1000),
      member,
    )) as [number, number, number];
    if (result[0] === 1) {
      return { allowed: true };
    }
    const reasons = { 1: 'cooldown', 2: 'phone_limit', 3: 'ip_limit' } as const;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(result[1] / 1000)),
      reason: reasons[result[2] as 1 | 2 | 3],
    };
  }
}
