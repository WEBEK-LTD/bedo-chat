import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedResponse } from '@bedo/contracts';
import type { Platform } from '@bedo/db';
import { sql } from 'kysely';
import { deviceLabel, type RequestInfo } from '../common/request-info.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { QueuesService } from '../queues/queues.service.js';
import { AccountsService } from './accounts.service.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './token.service.js';

/** Finishes a sign-in: creates the session, records it, and raises the login alert (D-13). */
@Injectable()
export class LoginService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QueuesService) private readonly queues: QueuesService,
  ) {}

  async complete(input: {
    userId: string;
    platform: Platform;
    deviceName: string | null;
    info: RequestInfo;
  }): Promise<{ response: AuthenticatedResponse; refreshToken: string }> {
    // Alerts describe the device from its browser signature in fixed words, never from text the client
    // sent, so a sign-in cannot place its own message in the account owner's alert.
    const alertDevice = deviceLabel(input.info.userAgent);
    const { session, hadOtherSessions } = await this.database.db.transaction().execute(async (trx) => {
      const others = await trx
        .selectFrom('app.sessions')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('user_id', '=', input.userId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirstOrThrow();
      const created = await this.sessions.create(trx, input);
      await this.audit.security(trx, {
        subjectType: 'user',
        subjectId: input.userId,
        event: 'login_succeeded',
        sessionId: created.sessionId,
        ip: input.info.ip,
        userAgent: input.info.userAgent,
        details: { platform: input.platform, deviceName: input.deviceName, newDevice: true },
      });
      // In-app security notice for the account; the new session itself does not show it.
      await trx
        .insertInto('app.security_notices')
        .values({
          user_id: input.userId,
          kind: 'new_login',
          session_id: created.sessionId,
          details: { deviceName: alertDevice, platform: input.platform, ip: input.info.ip },
        })
        .execute();
      return { session: created, hadOtherSessions: others.n > 0 };
    });

    if (hadOtherSessions) {
      await this.queues.enqueuePush({
        userId: input.userId,
        excludeSessionId: session.sessionId,
        notification: {
          title: 'New sign-in to Bedo Chat',
          body: `Your account was signed in on ${alertDevice ?? 'a new device'}. If this was not you, end that session in Devices.`,
          tag: 'new-login',
        },
      });
    }

    const user = await this.accounts.findById(this.database.db, input.userId);
    const access = await this.tokens.issue({ userId: input.userId, sessionId: session.sessionId });
    return {
      refreshToken: session.refreshToken,
      response: {
        status: 'authenticated',
        accessToken: access.token,
        accessTokenExpiresIn: access.expiresIn,
        user: await this.accounts.toMe(user!),
      },
    };
  }
}
