import { describe, expect, it } from 'vitest';
import { uuidV7 } from '../src/common/uuid-v7.js';

describe('uuidV7 (Phase 14.4)', () => {
  it('makes RFC 9562 version 7 ids carrying the time in milliseconds, like app.uuid_v7()', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0, 123);
    const id = uuidV7(now);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
  });

  it('orders by time and never repeats', () => {
    const ids = Array.from({ length: 1000 }, (_, index) => uuidV7(1_700_000_000_000 + index));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(Array.from({ length: 10_000 }, () => uuidV7())).size).toBe(10_000);
  });
});
