import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

export interface AuditLogTable {
  id: Generated<string>;
  occurred_at: ColumnType<Date, Date | string | undefined, never>;
  actor_type: 'user' | 'admin' | 'system';
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
}

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Json = ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;

export type UserStatus = 'active' | 'suspended' | 'banned' | 'deletion_requested' | 'deleted';
export type Visibility = 'everyone' | 'nobody';
export type Platform = 'web' | 'ios' | 'android' | 'desktop';
export type AdminRole = 'super_admin' | 'moderator';
export type ActorType = 'user' | 'admin' | 'system';
export type SessionRevokeReason =
  | 'logout'
  | 'terminated_by_user'
  | 'terminated_other_sessions'
  | 'refresh_reuse'
  | 'account_deleted'
  | 'account_blocked'
  | 'phone_changed';
export type OtpPurpose = 'sign_in' | 'change_phone' | 'admin_sign_in';
export type SecurityNoticeKind = 'new_login' | 'deletion_requested' | 'deletion_rejected' | 'two_step_reset';
export type AccountEvent = 'created' | 'deletion_requested' | 'deletion_approved' | 'deletion_rejected' | 'deleted';
export type IdentityField = 'phone' | 'name' | 'username' | 'bio' | 'photo';

export interface AcademyPhoneListTable {
  phone: string;
  note: string | null;
  added_by: string;
  added_at: CreatedAt;
}

export interface AdminAccountsTable {
  id: Generated<string>;
  phone: string;
  name: string;
  role: AdminRole;
  totp_secret_enc: string;
  totp_confirmed_at: Date | null;
  totp_last_step: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  status: Generated<'active' | 'disabled'>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface AdminSessionsTable {
  id: Generated<string>;
  admin_id: string;
  token_hash: string;
  created_at: CreatedAt;
  last_active_at: Timestamp;
  expires_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
  revoked_at: Date | null;
}

export interface UsersTable {
  id: Generated<string>;
  phone: string | null;
  name: string | null;
  username: string | null;
  bio: string | null;
  photo_key: string | null;
  status: Generated<UserStatus>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  deleted_at: Date | null;
}

export interface UserPrivacyTable {
  user_id: string;
  phone_visibility: Generated<Visibility>;
  last_seen_visibility: Generated<Visibility>;
  photo_visibility: Generated<Visibility>;
  messages_from: Generated<Visibility>;
  calls_from: Generated<Visibility>;
  updated_at: CreatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  user_id: string;
  refresh_hash: string;
  previous_refresh_hash: string | null;
  device_name: string | null;
  platform: Platform;
  ip: string | null;
  user_agent: string | null;
  created_at: CreatedAt;
  last_used_at: Timestamp;
  expires_at: Timestamp;
  revoked_at: Date | null;
  revoke_reason: SessionRevokeReason | null;
}

export interface OtpChallengesTable {
  id: Generated<string>;
  phone: string;
  purpose: OtpPurpose;
  code_hash: string;
  expires_at: Timestamp;
  attempts: Generated<number>;
  locked_at: Date | null;
  consumed_at: Date | null;
  ip: string | null;
  requested_by: ColumnType<string | null, string | null | undefined, never>;
  delivered: ColumnType<boolean, boolean, never>;
  created_at: CreatedAt;
}

export interface RetiredRefreshTokensTable {
  token_hash: string;
  session_id: string;
  retired_at: CreatedAt;
}

export interface TwoStepTable {
  user_id: string;
  password_hash: string;
  hint: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface AccountDeletionRequestsTable {
  id: Generated<string>;
  user_id: string;
  requested_at: CreatedAt;
  status: Generated<'pending' | 'approved' | 'rejected'>;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

export interface SecurityNoticesTable {
  id: Generated<string>;
  user_id: string;
  kind: SecurityNoticeKind;
  session_id: string | null;
  details: Json;
  created_at: CreatedAt;
  read_at: Date | null;
}

export interface PushSubscriptionsTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: CreatedAt;
}

export interface IdentityHistoryTable {
  id: Generated<string>;
  user_id: string;
  field: IdentityField;
  old_value: string | null;
  new_value: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  changed_at: CreatedAt;
}

export interface AccountEventsTable {
  id: Generated<string>;
  user_id: string;
  event: AccountEvent;
  actor_type: ActorType;
  actor_id: string | null;
  reason: string | null;
  details: Json;
  occurred_at: CreatedAt;
}

export interface SecurityEventsTable {
  id: Generated<string>;
  subject_type: 'user' | 'admin' | 'phone';
  subject_id: string | null;
  phone: string | null;
  event: string;
  session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: Json;
  occurred_at: CreatedAt;
}

/**
 * Typed view of the database. Tables are added here by the phase that creates them,
 * always together with their migration in supabase/migrations.
 */
export interface Database {
  'app.audit_log': AuditLogTable;
  'app.academy_phone_list': AcademyPhoneListTable;
  'app.admin_accounts': AdminAccountsTable;
  'app.admin_sessions': AdminSessionsTable;
  'app.users': UsersTable;
  'app.user_privacy': UserPrivacyTable;
  'app.sessions': SessionsTable;
  'app.retired_refresh_tokens': RetiredRefreshTokensTable;
  'app.otp_challenges': OtpChallengesTable;
  'app.two_step': TwoStepTable;
  'app.account_deletion_requests': AccountDeletionRequestsTable;
  'app.security_notices': SecurityNoticesTable;
  'app.push_subscriptions': PushSubscriptionsTable;
  'audit.identity_history': IdentityHistoryTable;
  'audit.account_events': AccountEventsTable;
  'audit.security_events': SecurityEventsTable;
}

export interface CreateDbOptions {
  connectionString: string;
  poolMax?: number;
  applicationName?: string;
  /** Server-side limit for any single statement (Postgres statement_timeout). */
  statementTimeoutMs?: number;
  /**
   * Called when an idle pooled connection fails (database restart, network cut, idle-connection
   * reaping by a proxy). Without a listener, Node would treat it as an unhandled error and exit.
   * The pool discards the broken connection and opens a new one on the next query.
   */
  onPoolError?: (error: Error) => void;
}

export interface DbHandle {
  db: Kysely<Database>;
  pool: pg.Pool;
  /** Round trip to Postgres, abandoned client-side after `timeoutMs` so a probe never pins a connection. */
  ping(timeoutMs: number): Promise<void>;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'bedo',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Client-side backstop for when the server cannot even be reached to enforce statement_timeout.
    query_timeout: statementTimeoutMs + 1_000,
    // Runs, and is awaited, before a new connection is handed out. Set here rather than as a startup
    // parameter, which some connection poolers reject. A failure discards the connection.
    onConnect: async (client) => {
      await client.query(`set statement_timeout = ${Math.trunc(statementTimeoutMs)}`);
    },
  });
  pool.on('error', (error: Error) => {
    options.onPoolError?.(error);
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const ping = async (timeoutMs: number): Promise<void> => {
    // query_timeout is a supported per-query option of node-postgres that its type definitions omit.
    await pool.query({ text: 'select 1', query_timeout: timeoutMs } as pg.QueryConfig);
  };
  return { db, pool, ping };
}
