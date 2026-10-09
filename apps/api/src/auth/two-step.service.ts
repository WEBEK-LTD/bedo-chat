import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { TOKEN_RULES } from '@bedo/contracts';
import type { Platform } from '@bedo/db';
import { type Algorithm, hash, verify } from '@node-rs/argon2';
import { AppError } from '../common/app-error.js';
import { hashToken, randomToken } from '../common/crypto.js';
import { EphemeralStore } from '../state/ephemeral.store.js';
import { RateLimitService } from '../state/rate-limit.service.js';

/** OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations, 1 lane). */
// algorithm 2 = Algorithm.Argon2id (a const enum, which isolated modules cannot import by name).
const ARGON2_OPTIONS = { algorithm: 2 as Algorithm, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export interface PendingTwoStepLogin {
  userId: string;
  platform: Platform;
  deviceName: string | null;
}

/** 2-Step Verification passwords (Argon2id) and the short-lived sign-in step token (P-09). */
@Injectable()
export class TwoStepService {
  constructor(
    @Inject(EphemeralStore) private readonly store: EphemeralStore,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  hashPassword(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  private failKey(userId: string): string {
    return `two-step-fail:${userId}`;
  }

  /**
   * Inside a signed-in session (change, disable, phone change) password checks are limited to
   * TOKEN_RULES.maxTwoStepPasswordAttempts per hour, so a stolen session cannot be used to guess it.
   * The attempt is counted before the check (parallel requests cannot share one count); a correct
   * password clears the count.
   */
  async reserveSessionAttempt(userId: string): Promise<void> {
    const attempt = await this.rateLimit.reserveAttempt(this.failKey(userId), 60 * 60 * 1000);
    if (attempt.count > TOKEN_RULES.maxTwoStepPasswordAttempts) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', attempt.retryAfterSeconds);
    }
  }

  async clearFailures(userId: string): Promise<void> {
    await this.rateLimit.reset(this.failKey(userId));
  }

  private key(token: string): string {
    return `two-step:${hashToken(token)}`;
  }

  private attemptsKey(token: string): string {
    return `two-step-attempts:${hashToken(token)}`;
  }

  async startLogin(pending: PendingTwoStepLogin): Promise<string> {
    const token = randomToken();
    await this.store.set(this.key(token), JSON.stringify(pending), TOKEN_RULES.twoStepTokenSeconds * 1000);
    return token;
  }

  async getLogin(token: string): Promise<PendingTwoStepLogin> {
    const raw = await this.store.get(this.key(token));
    if (!raw) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    return JSON.parse(raw) as PendingTwoStepLogin;
  }

  /**
   * Counts one password attempt for this sign-in before the password is checked (P-09). Beyond the
   * fifth, the attempt has ended and a new code is needed. Returns whether this is the last allowed try.
   */
  async reserveLoginAttempt(token: string): Promise<{ last: boolean }> {
    const attempt = await this.rateLimit.reserveAttempt(this.attemptsKey(token), TOKEN_RULES.twoStepTokenSeconds * 1000);
    if (attempt.count > TOKEN_RULES.maxTwoStepPasswordAttempts) {
      await this.store.delete(this.key(token));
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    return { last: attempt.count === TOKEN_RULES.maxTwoStepPasswordAttempts };
  }

  /** Ends the sign-in step. Returns false if another request already used it (only one may succeed). */
  async endLogin(token: string): Promise<boolean> {
    const removed = await this.store.delete(this.key(token));
    await this.rateLimit.reset(this.attemptsKey(token));
    return removed === 1;
  }
}

export function hintContainsPassword(hint: string | undefined, password: string): boolean {
  return Boolean(hint && hint.toLowerCase().includes(password.toLowerCase()));
}
