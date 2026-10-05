import { maskPhone, OTP_DELIVERY_ERRORS } from '@bedo/contracts';
import { describe, expect, it } from 'vitest';
import { classifyDeliveryFailure } from '../src/queues/queues.service.js';

describe('test message results (Phase 3.1)', () => {
  it('maps the worker failure texts to a reason, keeping only Waabek\'s HTTP status', () => {
    expect(classifyDeliveryFailure(OTP_DELIVERY_ERRORS.notConfigured)).toEqual({ reason: 'not_configured', httpStatus: null });
    expect(classifyDeliveryFailure(OTP_DELIVERY_ERRORS.keyUnreadable)).toEqual({ reason: 'key_unreadable', httpStatus: null });
    expect(classifyDeliveryFailure('Waabek send failed: HTTP 401')).toEqual({ reason: 'rejected', httpStatus: 401 });
    expect(classifyDeliveryFailure('Waabek send failed: timed out')).toEqual({ reason: 'unreachable', httpStatus: null });
    expect(classifyDeliveryFailure('Waabek send failed: network error')).toEqual({ reason: 'unreachable', httpStatus: null });
    // No worker answered in time (BullMQ's wait timeout), or anything unexpected.
    expect(classifyDeliveryFailure('Job wait waabek-test timed out before finishing, no finish notification arrived after 30000ms (id=1)')).toEqual({
      reason: 'no_answer',
      httpStatus: null,
    });
    expect(classifyDeliveryFailure('')).toEqual({ reason: 'no_answer', httpStatus: null });
  });

  it('shows only the start and end of the number', () => {
    expect(maskPhone('+905446731942')).toBe('+905******942');
    expect(maskPhone('+20123')).toBe('***');
  });
});
