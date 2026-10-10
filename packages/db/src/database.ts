import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { SUPABASE_ROOT_CA_2021 } from './supabase-ca.js';

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
  | 'phone_changed'
  | 'ended_by_admin';
export type OtpPurpose = 'sign_in' | 'change_phone' | 'admin_sign_in';
export type SecurityNoticeKind = 'new_login' | 'deletion_requested' | 'deletion_rejected' | 'two_step_reset';
export type AccountEvent = 'created' | 'deletion_requested' | 'deletion_approved' | 'deletion_rejected' | 'deleted' | 'suspended' | 'banned' | 'reactivated';
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
  /** NULL for an account created by SQL until its authenticator is set up (Phase 3.1). */
  totp_secret_enc: string | null;
  /** Argon2id hash of the admin password (D-34); NULL until set with an owner-issued setup token. */
  password_hash: string | null;
  /** Set by a trigger whenever the hash changes. */
  password_changed_at: ColumnType<Date | null, never, never>;
  totp_confirmed_at: Date | null;
  totp_last_step: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  status: Generated<'active' | 'disabled'>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

/** OTP delivery settings (D-32): one row; the Waabek API key only ever encrypted. */
export type SignupMode = 'open' | 'academy_list';
/** D-47: who can create an account. One row. */
export interface AccessSettingsTable {
  id: Generated<boolean>;
  signup_mode: Generated<SignupMode>;
  updated_by: string | null;
  updated_at: Date | null;
}

/** Site monitoring (Phase 14.5). */
export type SiteCheckKind = 'heartbeat' | 'manual';
export type SiteIncidentKind = 'outage' | 'storage' | 'whatsapp' | 'database_slow';

export interface SiteChecksTable {
  id: Generated<string>;
  checked_at: Generated<Date>;
  kind: SiteCheckKind;
  ok: boolean;
  database_ms: number | null;
  storage_ms: number | null;
  storage_ok: boolean | null;
  server_region: string | null;
  detail: string | null;
}

export interface SiteIncidentsTable {
  id: Generated<string>;
  kind: SiteIncidentKind;
  started_at: Date;
  ended_at: Date | null;
  detail: string | null;
  alerted_at: Date | null;
  recovery_alerted_at: Date | null;
}

export interface MonitoringSettingsTable {
  id: Generated<boolean>;
  whatsapp_alerts: Generated<boolean>;
  updated_by: string | null;
  updated_at: Date | null;
}

export interface OtpSettingsTable {
  id: Generated<boolean>;
  provider: Generated<'waabek'>;
  waabek_api_key_enc: string | null;
  /** Raised by a trigger on every change. */
  version: ColumnType<string, never, never>;
  updated_by: string | null;
  updated_via: 'initial_setup' | 'admin_dashboard' | 'owner_recovery' | null;
  updated_at: ColumnType<Date | null, never, never>;
}

/** One-time initial Super Admin setup (Phase 3.1): one row. */
export interface AdminBootstrapTable {
  id: Generated<boolean>;
  token_hash: ColumnType<string | null, never, never>;
  expires_at: ColumnType<Date | null, never, never>;
  failed_attempts: ColumnType<number, never, number>;
  opened_at: ColumnType<Date | null, never, never>;
  closed_at: ColumnType<Date | null, never, Date>;
  closed_by: ColumnType<string | null, never, string>;
}

/** Owner-issued admin password setup tokens (D-34): at most one per admin. */
export interface AdminPasswordSetupTable {
  admin_id: ColumnType<string, never, never>;
  token_hash: ColumnType<string, never, never>;
  expires_at: ColumnType<Date, never, never>;
  failed_attempts: ColumnType<number, never, number>;
  issued_at: ColumnType<Date, never, never>;
  is_reset: ColumnType<boolean, never, never>;
  used_at: ColumnType<Date | null, never, Date>;
}

/** Owner-only Waabek key recovery (D-33): one row. */
export interface OtpSettingsRecoveryTable {
  id: Generated<boolean>;
  token_hash: ColumnType<string | null, never, never>;
  expires_at: ColumnType<Date | null, never, never>;
  failed_attempts: ColumnType<number, never, number>;
  opened_at: ColumnType<Date | null, never, never>;
  key_saved_at: ColumnType<Date | null, never, Date>;
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
  /** Unused since D-45 (no calls); kept so the live database needs no change. */
  calls_from: Generated<Visibility>;
  updated_at: CreatedAt;
}

/** Phase 13 (D-46): the site's Web Push key pair, one row, never changed. */
export interface PushKeysTable {
  id: Generated<boolean>;
  public_key: string;
  private_key_enc: string;
  created_at: CreatedAt;
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

// Phase 3: messaging core.
export type ConversationType = 'private' | 'group' | 'channel';
export type MemberRole = 'owner' | 'admin' | 'member' | 'subscriber';
export type ScheduledStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
export type MessageKind = 'text' | 'media' | 'sticker' | 'poll';
export type FileKind = 'photo' | 'video' | 'audio' | 'voice' | 'video_note' | 'file' | 'gif';
export type ReportReason = 'spam' | 'harassment' | 'inappropriate_content' | 'other';
export type MessageRevisionAction = 'edited' | 'deleted_for_me' | 'deleted_for_both';
type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface ConversationsTable {
  id: Generated<string>;
  type: ConversationType;
  private_low: string | null;
  private_high: string | null;
  created_by: string;
  last_seq: ColumnType<string, string | number | undefined, string | number>;
  last_message_at: Date | null;
  created_at: CreatedAt;
  title: string | null;
  description: string | null;
  photo_key: string | null;
  deleted_at: Date | null;
  is_public: Generated<boolean>;
}

export interface ConversationMembersTable {
  conversation_id: string;
  user_id: string;
  joined_at: CreatedAt;
  read_seq: ColumnType<string, string | number | undefined, string | number>;
  delivered_seq: ColumnType<string, string | number | undefined, string | number>;
  role: Generated<MemberRole>;
  admin_rights: Generated<string[]>;
  denied_permissions: Generated<string[]>;
  restricted_until: Date | null;
}

export interface GroupSettingsTable {
  conversation_id: string;
  default_permissions: Generated<string[]>;
  hide_member_count: Generated<boolean>;
  hide_member_list: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface InviteLinksTable {
  id: Generated<string>;
  conversation_id: string;
  code: string;
  name: string | null;
  created_by: string;
  created_at: CreatedAt;
  expires_at: Date | null;
  usage_limit: number | null;
  usage_count: Generated<number>;
  requires_approval: Generated<boolean>;
  revoked_at: Date | null;
}

export interface JoinRequestsTable {
  id: Generated<string>;
  conversation_id: string;
  user_id: string;
  invite_link_id: string | null;
  requested_at: CreatedAt;
  status: Generated<'pending' | 'approved' | 'declined' | 'withdrawn'>;
  decided_by: string | null;
  decided_at: Date | null;
}

export interface PollsTable {
  id: Generated<string>;
  conversation_id: string;
  created_by: string;
  question: string;
  options: string[];
  kind: 'regular' | 'quiz';
  anonymous: boolean;
  multiple: boolean;
  correct_option: number | null;
  explanation: string | null;
  closed_at: Date | null;
  created_at: CreatedAt;
}

export interface PollVotesTable {
  poll_id: string;
  user_id: string;
  options: number[];
  voted_at: CreatedAt;
}

export interface MessageMentionsTable {
  message_id: string;
  conversation_id: string;
  user_id: string;
}

export interface UserPermissionsTable {
  user_id: string;
  create_groups: Generated<boolean>;
  create_channels: Generated<boolean>;
  schedule_messages: Generated<boolean>;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface MembershipEventsTable {
  id: Generated<string>;
  conversation_id: string;
  user_id: string;
  action: string;
  actor_type: ActorType;
  actor_id: string | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
  occurred_at: CreatedAt;
}

export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  seq: BigIntColumn;
  sender_id: string;
  client_id: string;
  kind: Generated<MessageKind>;
  text: string | null;
  reply_to_id: string | null;
  forward_from_user_id: string | null;
  forward_from_chat_id: string | null;
  created_at: CreatedAt;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  file_id: string | null;
  sticker_id: string | null;
  poll_id: string | null;
  /** Phase 10: removed for everyone by this admin (O-18: a reported message). */
  removed_by_admin: string | null;
  search_vector: ColumnType<string, never, never>;
}

export interface FilesTable {
  id: Generated<string>;
  owner_id: string;
  kind: FileKind;
  mime_type: string;
  size_bytes: BigIntColumn;
  file_name: string | null;
  object_path: string;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  waveform: number[] | null;
  status: Generated<'pending' | 'ready'>;
  created_at: CreatedAt;
  ready_at: Date | null;
}

export interface StickerPacksTable {
  id: Generated<string>;
  name: string;
  created_by: string | null;
  created_at: CreatedAt;
  archived_at: Date | null;
}

export interface StickersTable {
  id: Generated<string>;
  pack_id: string;
  emoji: string;
  object_path: string;
  mime_type: 'image/png' | 'image/webp';
  width: number;
  height: number;
  position: Generated<number>;
  created_at: CreatedAt;
  removed_at: Date | null;
}

export interface GifSettingsTable {
  id: Generated<boolean>;
  giphy_key_enc: string | null;
  updated_by: string | null;
  updated_at: Date | null;
}

export interface GifFilesTable {
  giphy_id: string;
  file_id: string;
  created_at: CreatedAt;
}

export interface MessageReactionsTable {
  message_id: string;
  conversation_id: string;
  user_id: string;
  emoji: string;
  created_at: CreatedAt;
}

export interface MessageRequestsTable {
  sender_id: string;
  client_id: string;
  kind: 'send' | 'forward';
  conversation_id: string;
  message_ids: string[];
  created_at: CreatedAt;
}

export interface MessageHiddenTable {
  user_id: string;
  message_id: string;
  conversation_id: string;
  hidden_at: CreatedAt;
}

export interface MessagePinsTable {
  conversation_id: string;
  message_id: string;
  pinned_by: string;
  pinned_at: CreatedAt;
}

export interface UserChatStateTable {
  user_id: string;
  conversation_id: string;
  pinned_at: Date | null;
  archived_at: Date | null;
  marked_unread: Generated<boolean>;
  muted_until: Date | null;
  updated_at: CreatedAt;
}

export interface ChatFoldersTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
}

export interface ChatFolderChatsTable {
  folder_id: string;
  conversation_id: string;
}

export interface BlocksTable {
  blocker_id: string;
  blocked_id: string;
  created_at: CreatedAt;
}

export interface ReportsTable {
  id: Generated<string>;
  reporter_id: string;
  reported_user_id: string;
  conversation_id: string | null;
  message_id: string | null;
  reason: ReportReason;
  details: string | null;
  message_text: string | null;
  created_at: CreatedAt;
}

export interface UserSyncStateTable {
  user_id: string;
  last_seq: ColumnType<string, string | number | undefined, string | number>;
  pruned_through_seq: ColumnType<string, string | number | undefined, string | number>;
}

export interface UpdateLogTable {
  user_id: string;
  seq: BigIntColumn;
  kind: string;
  conversation_id: string | null;
  message_id: string | null;
  data: Json;
  created_at: CreatedAt;
}

export interface UserPresenceTable {
  user_id: string;
  last_seen_at: Timestamp;
}

/** Phase 3.3 (D-36): short-lived server state with an expiry (what Redis held before). */
export interface EphemeralTable {
  key: string;
  value: string;
  expires_at: Timestamp;
}

export interface RateCountersTable {
  key: string;
  count: number;
  expires_at: Timestamp;
}

export interface RateEventsTable {
  bucket: string;
  at: Timestamp;
}

export interface PresenceDevicesTable {
  user_id: string;
  session_id: string;
  expires_at: Timestamp;
  /** Phase 7: the chat this device is showing (not pushed about it). */
  viewing_chat_id: string | null;
}

/** Phase 10: the decision on a report (append-only). */
export interface ReportDecisionsTable {
  report_id: string;
  admin_id: string;
  decision: 'dismissed' | 'message_removed' | 'user_suspended' | 'user_banned';
  note: string | null;
  decided_at: CreatedAt;
}

/** Phase 10 (O-20): notifications an admin sends to everyone or to one chat's members, sent in batches. */
export interface BroadcastsTable {
  id: Generated<string>;
  admin_id: string;
  title: string;
  body: string;
  audience: 'all' | 'chat';
  conversation_id: string | null;
  status: Generated<'sending' | 'sent'>;
  last_subscription_id: string | null;
  devices: Generated<number>;
  created_at: CreatedAt;
  finished_at: Date | null;
}

/** Phase 9: people an admin removed from a group or channel (they cannot rejoin on their own). */
export interface ChatBansTable {
  conversation_id: string;
  user_id: string;
  banned_by: string | null;
  /** Phase 10: removed by a system admin. */
  banned_by_admin: string | null;
  banned_at: CreatedAt;
}

/** Phase 7: notification settings per user (defaults when there is no row). */
export interface NotificationSettingsTable {
  user_id: string;
  private_chats: Generated<boolean>;
  groups: Generated<boolean>;
  channels: Generated<boolean>;
  previews: Generated<boolean>;
  updated_at: CreatedAt;
}

export interface MaintenanceRunsTable {
  name: string;
  last_run_at: Timestamp;
}

export interface MessageRevisionsTable {
  id: Generated<string>;
  message_id: string;
  conversation_id: string;
  sender_id: string;
  action: MessageRevisionAction;
  previous_text: string | null;
  new_text: string | null;
  file_id: string | null;
  sticker_id: string | null;
  poll_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  session_id: string | null;
  /** Set by a database trigger to the writing transaction. */
  tx_id: ColumnType<string, never, never>;
  occurred_at: CreatedAt;
}

/** Phase 6: messages sent by the API at a set time. */
export interface ScheduledMessagesTable {
  id: Generated<string>;
  conversation_id: string;
  sender_id: string;
  session_id: string;
  client_id: string;
  send_at: Date;
  payload: Json;
  status: Generated<ScheduledStatus>;
  attempts: Generated<number>;
  error_code: string | null;
  message_id: string | null;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  sent_at: Date | null;
}

export interface ScreenshotEventsTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  platform: 'ios' | 'android';
  device_name: string | null;
  conversation_id: string | null;
  screen: string;
  message_ids: ColumnType<string[], string[] | undefined, never>;
  occurred_at: ColumnType<Date, Date | string, never>;
  received_at: CreatedAt;
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
  'app.otp_settings': OtpSettingsTable;
  'app.access_settings': AccessSettingsTable;
  'app.site_checks': SiteChecksTable;
  'app.site_incidents': SiteIncidentsTable;
  'app.monitoring_settings': MonitoringSettingsTable;
  'app.admin_bootstrap': AdminBootstrapTable;
  'app.otp_settings_recovery': OtpSettingsRecoveryTable;
  'app.admin_password_setup': AdminPasswordSetupTable;
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
  'app.conversations': ConversationsTable;
  'app.conversation_members': ConversationMembersTable;
  'app.messages': MessagesTable;
  'app.message_requests': MessageRequestsTable;
  'app.message_hidden': MessageHiddenTable;
  'app.message_pins': MessagePinsTable;
  'app.user_chat_state': UserChatStateTable;
  'app.chat_folders': ChatFoldersTable;
  'app.chat_folder_chats': ChatFolderChatsTable;
  'app.blocks': BlocksTable;
  'app.reports': ReportsTable;
  'app.user_sync_state': UserSyncStateTable;
  'app.update_log': UpdateLogTable;
  'app.user_presence': UserPresenceTable;
  'app.ephemeral': EphemeralTable;
  'app.rate_counters': RateCountersTable;
  'app.rate_events': RateEventsTable;
  'app.presence_devices': PresenceDevicesTable;
  'app.maintenance_runs': MaintenanceRunsTable;
  'audit.message_revisions': MessageRevisionsTable;
  'audit.screenshot_events': ScreenshotEventsTable;
  'app.files': FilesTable;
  'app.sticker_packs': StickerPacksTable;
  'app.stickers': StickersTable;
  'app.gif_settings': GifSettingsTable;
  'app.gif_files': GifFilesTable;
  'app.message_reactions': MessageReactionsTable;
  'app.group_settings': GroupSettingsTable;
  'app.invite_links': InviteLinksTable;
  'app.join_requests': JoinRequestsTable;
  'app.polls': PollsTable;
  'app.poll_votes': PollVotesTable;
  'app.message_mentions': MessageMentionsTable;
  'app.scheduled_messages': ScheduledMessagesTable;
  'app.notification_settings': NotificationSettingsTable;
  'app.chat_bans': ChatBansTable;
  'app.report_decisions': ReportDecisionsTable;
  'app.broadcasts': BroadcastsTable;
  'app.push_keys': PushKeysTable;
  'app.user_permissions': UserPermissionsTable;
  'audit.membership_events': MembershipEventsTable;
}

export interface CreateDbOptions {
  connectionString: string;
  poolMax?: number;
  applicationName?: string;
  /** Server-side limit for any single statement (Postgres statement_timeout). */
  statementTimeoutMs?: number;
  /** How long an unused pooled connection stays open (default 30 s). */
  idleTimeoutMs?: number;
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

/**
 * Supabase's transaction-mode pooler (Supavisor) listens on 6543: consecutive transactions of one client may
 * run on different server connections, so no session setting can be relied on there.
 */
export function usesTransactionPooler(connectionString: string): boolean {
  try {
    return new URL(connectionString).port === '6543';
  } catch {
    return false;
  }
}

/**
 * TLS for a database connection (D-36). Every connection to a Supabase host (`*.supabase.com`, `*.supabase.co`) is
 * encrypted and fully verified against Supabase's root certificate, including the host name, with nothing to
 * configure. The host is read exactly as node-postgres reads it (including a `?host=` parameter, letter case, a
 * trailing dot or percent-encoding). A Supabase connection string that sets its own TLS options keeps them only if
 * they still verify the server; one that turns verification or TLS off is refused. Other hosts (local development,
 * tests) are unchanged.
 */
export function connectionTls(connectionString: string): pg.ConnectionConfig['ssl'] {
  const unset = { bedoNoSslOptionsInUrl: true } as unknown as pg.ConnectionConfig['ssl'];
  let parsed: { host?: unknown; ssl?: unknown };
  try {
    // Parses the string the way the driver will, without connecting. Options in the URL replace `ssl` here.
    parsed = (new pg.Client({ connectionString, ssl: unset }) as unknown as { connectionParameters: { host?: unknown; ssl?: unknown } })
      .connectionParameters;
  } catch {
    return undefined;
  }
  const host = String(parsed.host ?? '').toLowerCase().replace(/\.+$/, '');
  if (!host.endsWith('.supabase.com') && !host.endsWith('.supabase.co')) {
    return undefined;
  }
  if (parsed.ssl === unset) {
    return { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true };
  }
  if (parsed.ssl && typeof parsed.ssl === 'object' && (parsed.ssl as { rejectUnauthorized?: unknown }).rejectUnauthorized !== false) {
    return undefined; // the URL's own TLS options, which verify the server (e.g. sslmode=verify-full&sslrootcert=...)
  }
  throw new Error('DATABASE_URL: a Supabase connection must verify the server certificate; remove its sslmode (TLS is verified automatically)');
}

export function createDb(options: CreateDbOptions): DbHandle {
  const statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
  const transactionPooler = usesTransactionPooler(options.connectionString);
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ssl: connectionTls(options.connectionString),
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? 'bedo',
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: 5_000,
    // Client-side backstop for when the server cannot even be reached to enforce statement_timeout.
    query_timeout: statementTimeoutMs + 1_000,
    // Runs, and is awaited, before a new connection is handed out. Set here rather than as a startup
    // parameter, which some connection poolers reject. A failure discards the connection. Not with the
    // transaction pooler, where a session setting would not stay with this client (query_timeout above
    // still bounds every query).
    onConnect: async (client) => {
      if (!transactionPooler) {
        await client.query(`set statement_timeout = ${Math.trunc(statementTimeoutMs)}`);
      }
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
