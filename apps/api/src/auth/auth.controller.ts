import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import {
  type AuthenticatedResponse,
  authenticatedResponseSchema,
  okResponseSchema,
  type OtpRequestBody,
  otpRequestBodySchema,
  otpRequestResponseSchema,
  type OtpVerifyBody,
  otpVerifyBodySchema,
  type OtpVerifyResponse,
  otpVerifyResponseSchema,
  REFRESH_COOKIE,
  type TwoStepVerifyBody,
  twoStepVerifyBodySchema,
} from '@bedo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { normalizePhone } from '../common/phone.js';
import { deviceLabel, requestInfo } from '../common/request-info.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { API_ENV } from '../config/tokens.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { joinEveryoneChannels } from '../groups/everyone-channels.js';
import { assertCsrf } from '../security/csrf.js';
import { AccountsService } from './accounts.service.js';
import { clearRefreshCookie, setRefreshCookie } from './cookies.js';
import { LoginService } from './login.service.js';
import { OtpService } from './otp.service.js';
import { SessionsService } from './sessions.service.js';
import { TokenService } from './token.service.js';
import { TwoStepService } from './two-step.service.js';

export function requirePhone(input: string): string {
  const phone = normalizePhone(input);
  if (!phone) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
  }
  return phone;
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(LoginService) private readonly login: LoginService,
    @Inject(TwoStepService) private readonly twoStep: TwoStepService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Step 1: request a code. The same answer for every valid number (D-06). */
  @Post('otp/request')
  @HttpCode(200)
  @ResponseSchema(otpRequestResponseSchema)
  async requestCode(@Body(new ZodValidationPipe(otpRequestBodySchema)) body: OtpRequestBody, @Req() request: FastifyRequest) {
    const phone = requirePhone(body.phone);
    const db = this.database.db;
    const [listed, user] = await Promise.all([this.accounts.mayUseNumber(db, phone), this.accounts.findByPhone(db, phone)]);
    return this.otp.issue({
      purpose: 'sign_in',
      phone,
      eligible: listed || Boolean(user),
      subject: user ? { subjectType: 'user', subjectId: user.id } : { subjectType: 'phone', subjectId: null },
      info: requestInfo(request),
    });
  }

  /** Step 2: verify the code. Creates the account on first sign-in of a listed number. */
  @Post('otp/verify')
  @HttpCode(200)
  @ResponseSchema(otpVerifyResponseSchema)
  async verifyCode(
    @Body(new ZodValidationPipe(otpVerifyBodySchema)) body: OtpVerifyBody,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OtpVerifyResponse> {
    const phone = requirePhone(body.phone);
    const info = requestInfo(request);
    const existing = await this.accounts.findByPhone(this.database.db, phone);
    await this.otp.check({
      purpose: 'sign_in',
      phone,
      code: body.code,
      subject: existing ? { subjectType: 'user', subjectId: existing.id } : { subjectType: 'phone', subjectId: null },
      info,
    });

    // Second check: an account is only ever created for a number that may have one (D-06, D-47).
    if (!existing && !(await this.accounts.mayUseNumber(this.database.db, phone))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'OTP_INVALID');
    }
    const user = existing ?? (await this.createAccount(phone));
    if (user.status === 'suspended' || user.status === 'banned') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
    const deviceName = body.deviceName ?? deviceLabel(info.userAgent);

    const twoStep = await this.database.db
      .selectFrom('app.two_step')
      .select(['hint'])
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (twoStep) {
      const twoStepToken = await this.twoStep.startLogin({ userId: user.id, platform: 'web', deviceName });
      return { status: 'two_step_required', twoStepToken, hint: twoStep.hint };
    }

    const { response, refreshToken } = await this.login.complete({ userId: user.id, platform: 'web', deviceName, info });
    setRefreshCookie(reply, this.env, refreshToken);
    return response;
  }

  /** Step 3 (only with 2-Step Verification): the password. Five wrong passwords end the attempt (P-09). */
  @Post('two-step/verify')
  @HttpCode(200)
  @ResponseSchema(authenticatedResponseSchema)
  async verifyTwoStep(
    @Body(new ZodValidationPipe(twoStepVerifyBodySchema)) body: TwoStepVerifyBody,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthenticatedResponse> {
    const info = requestInfo(request);
    const pending = await this.twoStep.getLogin(body.twoStepToken);
    const attempt = await this.twoStep.reserveLoginAttempt(body.twoStepToken);
    const record = await this.database.db
      .selectFrom('app.two_step')
      .select(['password_hash'])
      .where('user_id', '=', pending.userId)
      .executeTakeFirst();
    // If the password was reset meanwhile, the step is no longer needed but the token must be renewed.
    if (!record || !(await this.twoStep.verifyPassword(record.password_hash, body.password))) {
      const ended = attempt.last;
      if (ended) {
        await this.twoStep.endLogin(body.twoStepToken);
      }
      await this.audit.security(this.database.db, {
        subjectType: 'user',
        subjectId: pending.userId,
        event: ended ? 'two_step_attempts_exhausted' : 'two_step_failed',
        ip: info.ip,
        userAgent: info.userAgent,
      });
      throw new AppError(ended ? HttpStatus.UNAUTHORIZED : HttpStatus.BAD_REQUEST, ended ? 'SESSION_INVALID' : 'TWO_STEP_INVALID');
    }
    if (!(await this.twoStep.endLogin(body.twoStepToken))) {
      // A parallel request with the same step token already completed the sign-in.
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    const user = await this.accounts.findById(this.database.db, pending.userId);
    if (!user || user.status === 'deleted') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'ACCOUNT_DELETED');
    }
    if (user.status === 'suspended' || user.status === 'banned') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_BLOCKED');
    }
    const { response, refreshToken } = await this.login.complete({
      userId: pending.userId,
      platform: pending.platform,
      deviceName: pending.deviceName,
      info,
    });
    setRefreshCookie(reply, this.env, refreshToken);
    return response;
  }

  /** Exchanges the refresh cookie for a new access token and a rotated refresh cookie (P-01, P-02). */
  @Post('refresh')
  @HttpCode(200)
  @ResponseSchema(authenticatedResponseSchema)
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<AuthenticatedResponse> {
    assertCsrf(request);
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_INVALID');
    }
    let result;
    try {
      result = await this.sessions.rotate(token, requestInfo(request));
    } catch (error) {
      clearRefreshCookie(reply, this.env);
      throw error;
    }
    if (result.kind === 'rotated') {
      setRefreshCookie(reply, this.env, result.refreshToken);
    }
    const user = await this.accounts.findById(this.database.db, result.userId);
    const access = await this.tokens.issue({ userId: result.userId, sessionId: result.sessionId });
    return {
      status: 'authenticated',
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresIn,
      user: await this.accounts.toMe(user!),
    };
  }

  /** Ends this device's session immediately. */
  @Post('logout')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    assertCsrf(request);
    const token = request.cookies[REFRESH_COOKIE];
    clearRefreshCookie(reply, this.env);
    if (token) {
      const session = await this.sessions.findByRefresh(token);
      if (session && !session.revoked_at) {
        const info = requestInfo(request);
        await this.database.db.transaction().execute(async (trx) => {
          await this.sessions.revoke(trx, session.id, 'logout');
          await this.audit.security(trx, {
            subjectType: 'user',
            subjectId: session.user_id,
            event: 'logout',
            sessionId: session.id,
            ip: info.ip,
            userAgent: info.userAgent,
          });
        });
      }
    }
    return { ok: true as const };
  }

  private async createAccount(phone: string) {
    return this.database.db.transaction().execute(async (trx) => {
      const user = await trx.insertInto('app.users').values({ phone }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('app.user_privacy').values({ user_id: user.id }).execute();
      await this.audit.account(trx, { userId: user.id, event: 'created', actor: { type: 'system', id: null } });
      await this.audit.identity(trx, {
        userId: user.id,
        field: 'phone',
        oldValue: null,
        newValue: phone,
        actor: { type: 'system', id: null },
      });
      // D-52: a new account joins the academy's channels for everyone right away (no device to tell yet).
      await joinEveryoneChannels(trx, { userId: user.id }, { type: 'system', id: null });
      return user;
    });
  }
}
