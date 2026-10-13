import { maskPhone, OTP_DELIVERY_ERRORS } from '@bedo/contracts';
import { describe, expect, it } from 'vitest';
import { classifyDeliveryFailure } from '../src/delivery/otp-delivery.service.js';
import { WaabekError } from '../src/delivery/waabek.client.js';
import { OtpConfigurationError } from '../src/delivery/waabek-key.provider.js';

describe('test message results (Phase 3.1)', () => {
  it('maps delivery failures to a reason, keeping only Waabek\'s HTTP status', () => {
    expect(classifyDeliveryFailure(new OtpConfigurationError(OTP_DELIVERY_ERRORS.notConfigured))).toEqual({ reason: 'not_configured', httpStatus: null });
    expect(classifyDeliveryFailure(new OtpConfigurationError(OTP_DELIVERY_ERRORS.keyUnreadable))).toEqual({ reason: 'key_unreadable', httpStatus: null });
    expect(classifyDeliveryFailure(new WaabekError(401, 'HTTP 401', false))).toEqual({ reason: 'rejected', httpStatus: 401 });
    expect(classifyDeliveryFailure(new WaabekError(null, 'timed out', true))).toEqual({ reason: 'unreachable', httpStatus: null });
    expect(classifyDeliveryFailure(new WaabekError(null, 'network error', true))).toEqual({ reason: 'unreachable', httpStatus: null });
    // Anything unexpected (the database not answering, a bug).
    expect(classifyDeliveryFailure(new Error('connection terminated'))).toEqual({ reason: 'no_answer', httpStatus: null });
    expect(classifyDeliveryFailure(undefined)).toEqual({ reason: 'no_answer', httpStatus: null });
  });

  it('shows only the start and end of the number', () => {
    expect(maskPhone('+905446731942')).toBe('+905******942');
    expect(maskPhone('+20123')).toBe('***');
  });
});
