import { describe, expect, it } from 'vitest';
import { ipBucket } from '../src/redis/rate-limit.service.js';

describe('per-IP limit buckets', () => {
  it('counts IPv4 addresses individually, including IPv4-mapped IPv6', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts every address of an IPv6 /64 together', () => {
    const bucket = ipBucket('2001:db8:abcd:12:1:2:3:4');
    expect(bucket).toBe('2001:db8:abcd:12::/64');
    expect(ipBucket('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff')).toBe(bucket);
    expect(ipBucket('2001:db8:abcd:12::99')).toBe(bucket);
    expect(ipBucket('2001:db8:abcd:13::1')).not.toBe(bucket);
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('leaves anything else unchanged', () => {
    expect(ipBucket('unknown')).toBe('unknown');
  });
});
