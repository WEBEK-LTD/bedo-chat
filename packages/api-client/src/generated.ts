// GENERATED FILE - do not edit. Run `pnpm --filter @bedo/api-client generate` after the API contracts change.
import { apiFetch } from './transport.js';
export type ErrorEnvelopeErrorCode = typeof ErrorEnvelopeErrorCode[keyof typeof ErrorEnvelopeErrorCode];


export const ErrorEnvelopeErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
  OTP_INVALID: 'OTP_INVALID',
  OTP_LOCKED: 'OTP_LOCKED',
  TWO_STEP_INVALID: 'TWO_STEP_INVALID',
  TWO_STEP_REQUIRED: 'TWO_STEP_REQUIRED',
  TOTP_INVALID: 'TOTP_INVALID',
  SESSION_INVALID: 'SESSION_INVALID',
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  CSRF_REJECTED: 'CSRF_REJECTED',
  SETUP_UNAVAILABLE: 'SETUP_UNAVAILABLE',
  SETUP_TOKEN_INVALID: 'SETUP_TOKEN_INVALID',
  RECOVERY_UNAVAILABLE: 'RECOVERY_UNAVAILABLE',
  RECOVERY_TOKEN_INVALID: 'RECOVERY_TOKEN_INVALID',
  RECOVERY_TOKEN_USED: 'RECOVERY_TOKEN_USED',
  CREDENTIALS_INVALID: 'CREDENTIALS_INVALID',
  PASSWORD_SETUP_INVALID: 'PASSWORD_SETUP_INVALID',
  PASSWORD_IS_PHONE: 'PASSWORD_IS_PHONE',
  PASSWORD_TOO_COMMON: 'PASSWORD_TOO_COMMON',
  CANNOT_MESSAGE: 'CANNOT_MESSAGE',
  USER_BLOCKED: 'USER_BLOCKED',
  LIMIT_REACHED: 'LIMIT_REACHED',
  FILE_INVALID: 'FILE_INVALID',
  FEATURE_UNAVAILABLE: 'FEATURE_UNAVAILABLE',
  NOT_ALLOWED: 'NOT_ALLOWED',
} as const;

export type ErrorEnvelopeErrorFieldsItem = {
  path: string;
  message: string;
};

export type ErrorEnvelopeError = {
  code: ErrorEnvelopeErrorCode;
  message: string;
  requestId: string;
  fields?: ErrorEnvelopeErrorFieldsItem[];
  /** @exclusiveMinimum 0 */
  retryAfterSeconds?: number;
};

export interface ErrorEnvelope {
  error: ErrorEnvelopeError;
}

export type LiveResponseStatus = typeof LiveResponseStatus[keyof typeof LiveResponseStatus];


export const LiveResponseStatus = {
  ok: 'ok',
} as const;

export interface LiveResponse {
  status: LiveResponseStatus;
}

export type ReadyResponseStatus = typeof ReadyResponseStatus[keyof typeof ReadyResponseStatus];


export const ReadyResponseStatus = {
  ok: 'ok',
  unavailable: 'unavailable',
} as const;

export type ReadyResponseChecksDatabaseStatus = typeof ReadyResponseChecksDatabaseStatus[keyof typeof ReadyResponseChecksDatabaseStatus];


export const ReadyResponseChecksDatabaseStatus = {
  up: 'up',
  down: 'down',
} as const;

export type ReadyResponseChecksDatabase = {
  status: ReadyResponseChecksDatabaseStatus;
  /** @minimum 0 */
  latencyMs: number;
};

export type ReadyResponseChecks = {
  database: ReadyResponseChecksDatabase;
};

export interface ReadyResponse {
  status: ReadyResponseStatus;
  checks: ReadyResponseChecks;
}

export interface OtpRequestBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
}

export type OtpRequestResponseStatus = typeof OtpRequestResponseStatus[keyof typeof OtpRequestResponseStatus];


export const OtpRequestResponseStatus = {
  accepted: 'accepted',
} as const;

export interface OtpRequestResponse {
  status: OtpRequestResponseStatus;
  resendAfterSeconds: number;
  expiresInSeconds: number;
}

export interface OtpVerifyBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
  /** @pattern ^\d{6}$ */
  code: string;
  /**
     * @minLength 1
     * @maxLength 100
     */
  deviceName?: string;
}

export type OtpVerifyResponse = {
  status: 'authenticated';
  accessToken: string;
  accessTokenExpiresIn: number;
  user: {
  id: string;
  phone: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  status: 'active' | 'suspended' | 'banned' | 'deletion_requested' | 'deleted';
  twoStepEnabled: boolean;
  profileComplete: boolean;
};
} | {
  status: 'two_step_required';
  twoStepToken: string;
  /** @nullable */
  hint: string | null;
};

export interface TwoStepVerifyBody {
  /**
     * @minLength 10
     * @maxLength 200
     */
  twoStepToken: string;
  /**
     * @minLength 1
     * @maxLength 128
     */
  password: string;
}

export type AuthenticatedResponseStatus = typeof AuthenticatedResponseStatus[keyof typeof AuthenticatedResponseStatus];


export const AuthenticatedResponseStatus = {
  authenticated: 'authenticated',
} as const;

export type AuthenticatedResponseUserStatus = typeof AuthenticatedResponseUserStatus[keyof typeof AuthenticatedResponseUserStatus];


export const AuthenticatedResponseUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AuthenticatedResponseUser = {
  id: string;
  phone: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  status: AuthenticatedResponseUserStatus;
  twoStepEnabled: boolean;
  profileComplete: boolean;
};

export interface AuthenticatedResponse {
  status: AuthenticatedResponseStatus;
  accessToken: string;
  accessTokenExpiresIn: number;
  user: AuthenticatedResponseUser;
}

export interface OkResponse {
  ok: true;
}

export type MeStatus = typeof MeStatus[keyof typeof MeStatus];


export const MeStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export interface Me {
  id: string;
  phone: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  status: MeStatus;
  twoStepEnabled: boolean;
  profileComplete: boolean;
}

export interface UpdateMeBody {
  /**
     * @minLength 1
     * @maxLength 64
     */
  name?: string;
  /**
     * @nullable
     * @pattern ^[A-Za-z][A-Za-z0-9_]{4,31}$
     */
  username?: string | null;
  /**
     * @maxLength 140
     * @nullable
     */
  bio?: string | null;
}

export type PrivacyPhoneVisibility = typeof PrivacyPhoneVisibility[keyof typeof PrivacyPhoneVisibility];


export const PrivacyPhoneVisibility = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export type PrivacyLastSeenVisibility = typeof PrivacyLastSeenVisibility[keyof typeof PrivacyLastSeenVisibility];


export const PrivacyLastSeenVisibility = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export type PrivacyPhotoVisibility = typeof PrivacyPhotoVisibility[keyof typeof PrivacyPhotoVisibility];


export const PrivacyPhotoVisibility = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export type PrivacyMessagesFrom = typeof PrivacyMessagesFrom[keyof typeof PrivacyMessagesFrom];


export const PrivacyMessagesFrom = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export interface Privacy {
  phoneVisibility: PrivacyPhoneVisibility;
  lastSeenVisibility: PrivacyLastSeenVisibility;
  photoVisibility: PrivacyPhotoVisibility;
  messagesFrom: PrivacyMessagesFrom;
}

export type UpdatePrivacyBodyPhoneVisibility = typeof UpdatePrivacyBodyPhoneVisibility[keyof typeof UpdatePrivacyBodyPhoneVisibility];


export const UpdatePrivacyBodyPhoneVisibility = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export type UpdatePrivacyBodyLastSeenVisibility = typeof UpdatePrivacyBodyLastSeenVisibility[keyof typeof UpdatePrivacyBodyLastSeenVisibility];


export const UpdatePrivacyBodyLastSeenVisibility = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export type UpdatePrivacyBodyPhotoVisibility = typeof UpdatePrivacyBodyPhotoVisibility[keyof typeof UpdatePrivacyBodyPhotoVisibility];


export const UpdatePrivacyBodyPhotoVisibility = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export type UpdatePrivacyBodyMessagesFrom = typeof UpdatePrivacyBodyMessagesFrom[keyof typeof UpdatePrivacyBodyMessagesFrom];


export const UpdatePrivacyBodyMessagesFrom = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export interface UpdatePrivacyBody {
  phoneVisibility?: UpdatePrivacyBodyPhoneVisibility;
  lastSeenVisibility?: UpdatePrivacyBodyLastSeenVisibility;
  photoVisibility?: UpdatePrivacyBodyPhotoVisibility;
  messagesFrom?: UpdatePrivacyBodyMessagesFrom;
}

export type PhotoUploadBodyContentType = typeof PhotoUploadBodyContentType[keyof typeof PhotoUploadBodyContentType];


export const PhotoUploadBodyContentType = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
} as const;

export interface PhotoUploadBody {
  contentType: PhotoUploadBodyContentType;
  /**
     * @maximum 5242880
     * @exclusiveMinimum 0
     */
  size: number;
}

export type PhotoUploadResponseMethod = typeof PhotoUploadResponseMethod[keyof typeof PhotoUploadResponseMethod];


export const PhotoUploadResponseMethod = {
  PUT: 'PUT',
} as const;

export type PhotoUploadResponseHeaders = {[key: string]: string};

export interface PhotoUploadResponse {
  uploadId: string;
  uploadUrl: string;
  method: PhotoUploadResponseMethod;
  headers: PhotoUploadResponseHeaders;
}

export interface PhotoConfirmBody {
  /**
     * @minLength 10
     * @maxLength 200
     */
  uploadId: string;
}

export interface PhoneChangeRequestBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  newPhone: string;
}

export interface PhoneChangeVerifyBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  newPhone: string;
  /** @pattern ^\d{6}$ */
  code: string;
  /**
     * @minLength 1
     * @maxLength 128
     */
  twoStepPassword?: string;
}

export type SessionsResponseSessionsItemPlatform = typeof SessionsResponseSessionsItemPlatform[keyof typeof SessionsResponseSessionsItemPlatform];


export const SessionsResponseSessionsItemPlatform = {
  web: 'web',
  ios: 'ios',
  android: 'android',
  desktop: 'desktop',
} as const;

export type SessionsResponseSessionsItem = {
  id: string;
  /** @nullable */
  deviceName: string | null;
  platform: SessionsResponseSessionsItemPlatform;
  /** @nullable */
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
};

export interface SessionsResponse {
  sessions: SessionsResponseSessionsItem[];
}

export interface TwoStepStatus {
  enabled: boolean;
  /** @nullable */
  hint: string | null;
}

export interface TwoStepSetBody {
  /**
     * @minLength 1
     * @maxLength 128
     */
  currentPassword?: string;
  /**
     * @minLength 8
     * @maxLength 128
     */
  newPassword: string;
  /**
     * @minLength 1
     * @maxLength 64
     */
  hint?: string;
}

export interface TwoStepDisableBody {
  /**
     * @minLength 1
     * @maxLength 128
     */
  currentPassword: string;
}

export type SecurityNoticesResponseNoticesItemKind = typeof SecurityNoticesResponseNoticesItemKind[keyof typeof SecurityNoticesResponseNoticesItemKind];


export const SecurityNoticesResponseNoticesItemKind = {
  new_login: 'new_login',
  deletion_requested: 'deletion_requested',
  deletion_rejected: 'deletion_rejected',
  two_step_reset: 'two_step_reset',
} as const;

export type SecurityNoticesResponseNoticesItemDetailsPlatform = typeof SecurityNoticesResponseNoticesItemDetailsPlatform[keyof typeof SecurityNoticesResponseNoticesItemDetailsPlatform];


export const SecurityNoticesResponseNoticesItemDetailsPlatform = {
  web: 'web',
  ios: 'ios',
  android: 'android',
  desktop: 'desktop',
} as const;

export type SecurityNoticesResponseNoticesItemDetails = {
  /** @nullable */
  deviceName?: string | null;
  platform?: SecurityNoticesResponseNoticesItemDetailsPlatform;
  /** @nullable */
  ip?: string | null;
};

export type SecurityNoticesResponseNoticesItem = {
  id: string;
  kind: SecurityNoticesResponseNoticesItemKind;
  createdAt: string;
  read: boolean;
  details: SecurityNoticesResponseNoticesItemDetails;
};

export interface SecurityNoticesResponse {
  notices: SecurityNoticesResponseNoticesItem[];
  unreadCount: number;
}

export interface MarkNoticesReadBody {
  /**
     * @maxItems 100
     * @items.pattern ^\d+$
     */
  ids?: string[];
}

export interface PushConfigResponse {
  /** @nullable */
  vapidPublicKey: string | null;
}

export type PushSubscriptionBodyKeys = {
  /**
     * @minLength 1
     * @maxLength 200
     */
  p256dh: string;
  /**
     * @minLength 1
     * @maxLength 100
     */
  auth: string;
};

export interface PushSubscriptionBody {
  /** @maxLength 2000 */
  endpoint: string;
  keys: PushSubscriptionBodyKeys;
}

export type DeletionRequestResponseStatus = typeof DeletionRequestResponseStatus[keyof typeof DeletionRequestResponseStatus];


export const DeletionRequestResponseStatus = {
  deletion_requested: 'deletion_requested',
} as const;

export interface DeletionRequestResponse {
  status: DeletionRequestResponseStatus;
  requestedAt: string;
}

export interface AdminPasswordLoginBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
  /**
     * @minLength 1
     * @maxLength 1024
     */
  password: string;
}

export type AdminPasswordLoginResponseStatus = typeof AdminPasswordLoginResponseStatus[keyof typeof AdminPasswordLoginResponseStatus];


export const AdminPasswordLoginResponseStatus = {
  totp_required: 'totp_required',
  totp_setup_required: 'totp_setup_required',
} as const;

export interface AdminPasswordLoginResponse {
  status: AdminPasswordLoginResponseStatus;
  pendingToken: string;
}

export interface AdminPasswordSetupBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
  /**
     * @minLength 20
     * @maxLength 200
     */
  setupToken: string;
  password: string;
}

export interface AdminTotpVerifyBody {
  /**
     * @minLength 10
     * @maxLength 200
     */
  pendingToken: string;
  /** @pattern ^\d{6}$ */
  code: string;
}

export type AdminSessionResponseAdminRole = typeof AdminSessionResponseAdminRole[keyof typeof AdminSessionResponseAdminRole];


export const AdminSessionResponseAdminRole = {
  super_admin: 'super_admin',
  moderator: 'moderator',
} as const;

export type AdminSessionResponseAdmin = {
  id: string;
  name: string;
  role: AdminSessionResponseAdminRole;
};

export interface AdminSessionResponse {
  admin: AdminSessionResponseAdmin;
}

export interface AdminTotpSetupBody {
  /**
     * @minLength 10
     * @maxLength 200
     */
  pendingToken: string;
}

export interface AdminTotpSetupResponse {
  otpauthUri: string;
  setupKey: string;
  issuer: string;
  accountName: string;
}

export interface AdminBootstrapStatusResponse {
  setupOpen: boolean;
}

export interface AdminBootstrapWaabekKeyBody {
  /**
     * @minLength 20
     * @maxLength 200
     */
  setupToken: string;
  /**
     * @minLength 8
     * @maxLength 512
     * @pattern ^[\x21-\x7e]+$
     */
  apiKey: string;
}

export interface AdminBootstrapTestBody {
  /**
     * @minLength 20
     * @maxLength 200
     */
  setupToken: string;
}

/**
 * @nullable
 */
export type WaabekTestResponseReason = typeof WaabekTestResponseReason[keyof typeof WaabekTestResponseReason] | null;


export const WaabekTestResponseReason = {
  not_configured: 'not_configured',
  key_unreadable: 'key_unreadable',
  rejected: 'rejected',
  unreachable: 'unreachable',
  no_answer: 'no_answer',
} as const;

export interface WaabekTestResponse {
  delivered: boolean;
  sentTo: string;
  /** @nullable */
  reason: WaabekTestResponseReason;
  /** @nullable */
  httpStatus: number | null;
}

export interface OtpRecoveryStatusResponse {
  recoveryOpen: boolean;
}

export interface OtpRecoveryWaabekKeyBody {
  /**
     * @minLength 20
     * @maxLength 200
     */
  recoveryToken: string;
  /**
     * @minLength 8
     * @maxLength 512
     * @pattern ^[\x21-\x7e]+$
     */
  apiKey: string;
}

export interface OtpRecoveryTestBody {
  /**
     * @minLength 20
     * @maxLength 200
     */
  recoveryToken: string;
}

export interface AdminPasswordChangeBody {
  /**
     * @minLength 1
     * @maxLength 1024
     */
  currentPassword: string;
  newPassword: string;
  /** @pattern ^\d{6}$ */
  totpCode: string;
}

export interface AdminPasswordChangeResponse {
  changed: true;
  otherSessionsEnded: number;
}

/**
 * @nullable
 */
export type PhoneListResponseItemsItemAccountStatus = typeof PhoneListResponseItemsItemAccountStatus[keyof typeof PhoneListResponseItemsItemAccountStatus] | null;


export const PhoneListResponseItemsItemAccountStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type PhoneListResponseItemsItem = {
  phone: string;
  /** @nullable */
  note: string | null;
  addedAt: string;
  /** @nullable */
  accountStatus: PhoneListResponseItemsItemAccountStatus;
};

export interface PhoneListResponse {
  items: PhoneListResponseItemsItem[];
  /** @nullable */
  nextCursor: string | null;
}

export interface PhoneListAddBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
  /**
     * @minLength 1
     * @maxLength 200
     */
  note?: string;
}

export interface PhoneListAddResponse {
  phone: string;
  added: boolean;
}

export interface PhoneListImportBody {
  /**
     * @minLength 1
     * @maxLength 1000000
     */
  csv: string;
}

export type PhoneListImportResponseInvalidItem = {
  line: number;
  value: string;
  reason: string;
};

export interface PhoneListImportResponse {
  added: number;
  duplicates: string[];
  invalid: PhoneListImportResponseInvalidItem[];
}

export type DeletionRequestListResponseItemsItemStatus = typeof DeletionRequestListResponseItemsItemStatus[keyof typeof DeletionRequestListResponseItemsItemStatus];


export const DeletionRequestListResponseItemsItemStatus = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
} as const;

export type DeletionRequestListResponseItemsItemUser = {
  id: string;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
};

export type DeletionRequestListResponseItemsItem = {
  id: string;
  status: DeletionRequestListResponseItemsItemStatus;
  requestedAt: string;
  /** @nullable */
  decidedAt: string | null;
  user: DeletionRequestListResponseItemsItemUser;
};

export interface DeletionRequestListResponse {
  items: DeletionRequestListResponseItemsItem[];
}

export type DeletionRequestDetailRequestStatus = typeof DeletionRequestDetailRequestStatus[keyof typeof DeletionRequestDetailRequestStatus];


export const DeletionRequestDetailRequestStatus = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
} as const;

export type DeletionRequestDetailRequestUser = {
  id: string;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
};

export type DeletionRequestDetailRequest = {
  id: string;
  status: DeletionRequestDetailRequestStatus;
  requestedAt: string;
  /** @nullable */
  decidedAt: string | null;
  user: DeletionRequestDetailRequestUser;
  /** @nullable */
  decisionReason: string | null;
  /** @nullable */
  decidedBy: string | null;
};

export type DeletionRequestDetailAccountStatus = typeof DeletionRequestDetailAccountStatus[keyof typeof DeletionRequestDetailAccountStatus];


export const DeletionRequestDetailAccountStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type DeletionRequestDetailAccountActiveSessionsItemPlatform = typeof DeletionRequestDetailAccountActiveSessionsItemPlatform[keyof typeof DeletionRequestDetailAccountActiveSessionsItemPlatform];


export const DeletionRequestDetailAccountActiveSessionsItemPlatform = {
  web: 'web',
  ios: 'ios',
  android: 'android',
  desktop: 'desktop',
} as const;

export type DeletionRequestDetailAccountActiveSessionsItem = {
  /** @nullable */
  deviceName: string | null;
  platform: DeletionRequestDetailAccountActiveSessionsItemPlatform;
  lastUsedAt: string;
  /** @nullable */
  ip: string | null;
};

export type DeletionRequestDetailAccount = {
  status: DeletionRequestDetailAccountStatus;
  createdAt: string;
  /** @nullable */
  bio: string | null;
  twoStepEnabled: boolean;
  activeSessions: DeletionRequestDetailAccountActiveSessionsItem[];
};

export type DeletionRequestDetailIdentityHistoryItem = {
  at: string;
  event: string;
  /** @nullable */
  detail: string | null;
};

export type DeletionRequestDetailAccountEventsItem = {
  at: string;
  event: string;
  /** @nullable */
  detail: string | null;
};

export type DeletionRequestDetailSecurityEventsItem = {
  at: string;
  event: string;
  /** @nullable */
  detail: string | null;
};

export interface DeletionRequestDetail {
  request: DeletionRequestDetailRequest;
  account: DeletionRequestDetailAccount;
  identityHistory: DeletionRequestDetailIdentityHistoryItem[];
  accountEvents: DeletionRequestDetailAccountEventsItem[];
  securityEvents: DeletionRequestDetailSecurityEventsItem[];
}

export interface DeletionDecisionBody {
  /**
     * @minLength 1
     * @maxLength 500
     */
  reason?: string;
}

export interface TwoStepResetBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export interface TwoStepResetResponse {
  reset: true;
}

export type OtpSettingsResponseProvider = typeof OtpSettingsResponseProvider[keyof typeof OtpSettingsResponseProvider];


export const OtpSettingsResponseProvider = {
  waabek: 'waabek',
} as const;

/**
 * @nullable
 */
export type OtpSettingsResponseUpdatedBy = {
  id: string;
  name: string;
} | null;

/**
 * @nullable
 */
export type OtpSettingsResponseUpdatedVia = typeof OtpSettingsResponseUpdatedVia[keyof typeof OtpSettingsResponseUpdatedVia] | null;


export const OtpSettingsResponseUpdatedVia = {
  initial_setup: 'initial_setup',
  admin_dashboard: 'admin_dashboard',
  owner_recovery: 'owner_recovery',
} as const;

export interface OtpSettingsResponse {
  provider: OtpSettingsResponseProvider;
  apiKeyConfigured: boolean;
  version: number;
  /** @nullable */
  updatedAt: string | null;
  /** @nullable */
  updatedBy: OtpSettingsResponseUpdatedBy;
  /** @nullable */
  updatedVia: OtpSettingsResponseUpdatedVia;
}

export interface OtpSettingsReplaceKeyBody {
  /**
     * @minLength 8
     * @maxLength 512
     * @pattern ^[\x21-\x7e]+$
     */
  apiKey: string;
  /** @pattern ^\d{6}$ */
  totpCode: string;
}

export interface OtpSettingsReplaceKeyResponse {
  saved: true;
  version: number;
}

/**
 * @nullable
 */
export type UserSearchResponseUsersItemPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

export type UserSearchResponseUsersItem = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  presence: UserSearchResponseUsersItemPresence;
  blockedByMe: boolean;
  canMessage: boolean;
};

export interface UserSearchResponse {
  users: UserSearchResponseUsersItem[];
}

/**
 * @nullable
 */
export type PeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

export interface Peer {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  presence: PeerPresence;
  blockedByMe: boolean;
  canMessage: boolean;
}

export type ChatsResponseChatsItemType = typeof ChatsResponseChatsItemType[keyof typeof ChatsResponseChatsItemType];


export const ChatsResponseChatsItemType = {
  private: 'private',
  group: 'group',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemPeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemPeer = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  presence: ChatsResponseChatsItemPeerPresence;
  blockedByMe: boolean;
  canMessage: boolean;
} | null;

export type ChatsResponseChatsItemGroupRole = typeof ChatsResponseChatsItemGroupRole[keyof typeof ChatsResponseChatsItemGroupRole];


export const ChatsResponseChatsItemGroupRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type ChatsResponseChatsItemGroupAdminRightsItem = typeof ChatsResponseChatsItemGroupAdminRightsItem[keyof typeof ChatsResponseChatsItemGroupAdminRightsItem];


export const ChatsResponseChatsItemGroupAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type ChatsResponseChatsItemGroupPermissionsItem = typeof ChatsResponseChatsItemGroupPermissionsItem[keyof typeof ChatsResponseChatsItemGroupPermissionsItem];


export const ChatsResponseChatsItemGroupPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type ChatsResponseChatsItemGroupSettingsDefaultPermissionsItem = typeof ChatsResponseChatsItemGroupSettingsDefaultPermissionsItem[keyof typeof ChatsResponseChatsItemGroupSettingsDefaultPermissionsItem];


export const ChatsResponseChatsItemGroupSettingsDefaultPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemGroupSettings = {
  defaultPermissions: ChatsResponseChatsItemGroupSettingsDefaultPermissionsItem[];
  hideMemberCount: boolean;
  hideMemberList: boolean;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemGroup = {
  title: string;
  /** @nullable */
  description: string | null;
  /** @nullable */
  photoUrl: string | null;
  role: ChatsResponseChatsItemGroupRole;
  adminRights: ChatsResponseChatsItemGroupAdminRightsItem[];
  permissions: ChatsResponseChatsItemGroupPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  restricted: boolean;
  /**
     * @minimum 0
     * @nullable
     */
  memberCount: number | null;
  canViewMembers: boolean;
  /** @nullable */
  settings: ChatsResponseChatsItemGroupSettings;
  /**
     * @minimum 0
     * @nullable
     */
  pendingRequests: number | null;
  public: boolean;
} | null;

export type ChatsResponseChatsItemLastMessageKind = typeof ChatsResponseChatsItemLastMessageKind[keyof typeof ChatsResponseChatsItemLastMessageKind];


export const ChatsResponseChatsItemLastMessageKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type ChatsResponseChatsItemLastMessageAttachmentKind = typeof ChatsResponseChatsItemLastMessageAttachmentKind[keyof typeof ChatsResponseChatsItemLastMessageAttachmentKind];


export const ChatsResponseChatsItemLastMessageAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageAttachment = {
  id: string;
  kind: ChatsResponseChatsItemLastMessageAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type ChatsResponseChatsItemLastMessageReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type ChatsResponseChatsItemLastMessagePollKind = typeof ChatsResponseChatsItemLastMessagePollKind[keyof typeof ChatsResponseChatsItemLastMessagePollKind];


export const ChatsResponseChatsItemLastMessagePollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type ChatsResponseChatsItemLastMessagePollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessagePoll = {
  id: string;
  question: string;
  kind: ChatsResponseChatsItemLastMessagePollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: ChatsResponseChatsItemLastMessagePollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageReplyToMedia = typeof ChatsResponseChatsItemLastMessageReplyToMedia[keyof typeof ChatsResponseChatsItemLastMessageReplyToMedia] | null;


export const ChatsResponseChatsItemLastMessageReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: ChatsResponseChatsItemLastMessageReplyToMedia;
} | null;

export type ChatsResponseChatsItemLastMessageForwardedFromKind = typeof ChatsResponseChatsItemLastMessageForwardedFromKind[keyof typeof ChatsResponseChatsItemLastMessageForwardedFromKind];


export const ChatsResponseChatsItemLastMessageForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageForwardedFrom = {
  kind: ChatsResponseChatsItemLastMessageForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessage = {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: ChatsResponseChatsItemLastMessageKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: ChatsResponseChatsItemLastMessageAttachment;
  /** @nullable */
  sticker: ChatsResponseChatsItemLastMessageSticker;
  reactions: ChatsResponseChatsItemLastMessageReactionsItem[];
  /** @nullable */
  poll: ChatsResponseChatsItemLastMessagePoll;
  /** @nullable */
  sender: ChatsResponseChatsItemLastMessageSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: ChatsResponseChatsItemLastMessageReplyTo;
  /** @nullable */
  forwardedFrom: ChatsResponseChatsItemLastMessageForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
} | null;

export type ChatsResponseChatsItem = {
  id: string;
  type: ChatsResponseChatsItemType;
  /** @nullable */
  peer: ChatsResponseChatsItemPeer;
  /** @nullable */
  group: ChatsResponseChatsItemGroup;
  /** @nullable */
  lastMessage: ChatsResponseChatsItemLastMessage;
  /** @minimum 0 */
  lastSeq: number;
  /** @minimum 0 */
  readSeq: number;
  /** @minimum 0 */
  unreadCount: number;
  markedUnread: boolean;
  /** @minimum 0 */
  peerReadSeq: number;
  /** @minimum 0 */
  peerDeliveredSeq: number;
  /** @nullable */
  mutedUntil: string | null;
  pinned: boolean;
  /** @nullable */
  pinnedAt: string | null;
  archived: boolean;
  folderIds: string[];
  /** @minimum 0 */
  scheduledCount: number;
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
};

export interface ChatsResponse {
  chats: ChatsResponseChatsItem[];
}

export interface CreateChatBody {
  userId: string;
}

export type ChatType = typeof ChatType[keyof typeof ChatType];


export const ChatType = {
  private: 'private',
  group: 'group',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type ChatPeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

/**
 * @nullable
 */
export type ChatPeer = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  presence: ChatPeerPresence;
  blockedByMe: boolean;
  canMessage: boolean;
} | null;

export type ChatGroupRole = typeof ChatGroupRole[keyof typeof ChatGroupRole];


export const ChatGroupRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type ChatGroupAdminRightsItem = typeof ChatGroupAdminRightsItem[keyof typeof ChatGroupAdminRightsItem];


export const ChatGroupAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type ChatGroupPermissionsItem = typeof ChatGroupPermissionsItem[keyof typeof ChatGroupPermissionsItem];


export const ChatGroupPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type ChatGroupSettingsDefaultPermissionsItem = typeof ChatGroupSettingsDefaultPermissionsItem[keyof typeof ChatGroupSettingsDefaultPermissionsItem];


export const ChatGroupSettingsDefaultPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

/**
 * @nullable
 */
export type ChatGroupSettings = {
  defaultPermissions: ChatGroupSettingsDefaultPermissionsItem[];
  hideMemberCount: boolean;
  hideMemberList: boolean;
} | null;

/**
 * @nullable
 */
export type ChatGroup = {
  title: string;
  /** @nullable */
  description: string | null;
  /** @nullable */
  photoUrl: string | null;
  role: ChatGroupRole;
  adminRights: ChatGroupAdminRightsItem[];
  permissions: ChatGroupPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  restricted: boolean;
  /**
     * @minimum 0
     * @nullable
     */
  memberCount: number | null;
  canViewMembers: boolean;
  /** @nullable */
  settings: ChatGroupSettings;
  /**
     * @minimum 0
     * @nullable
     */
  pendingRequests: number | null;
  public: boolean;
} | null;

export type ChatLastMessageKind = typeof ChatLastMessageKind[keyof typeof ChatLastMessageKind];


export const ChatLastMessageKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type ChatLastMessageAttachmentKind = typeof ChatLastMessageAttachmentKind[keyof typeof ChatLastMessageAttachmentKind];


export const ChatLastMessageAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type ChatLastMessageAttachment = {
  id: string;
  kind: ChatLastMessageAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type ChatLastMessageSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type ChatLastMessageReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type ChatLastMessagePollKind = typeof ChatLastMessagePollKind[keyof typeof ChatLastMessagePollKind];


export const ChatLastMessagePollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type ChatLastMessagePollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type ChatLastMessagePoll = {
  id: string;
  question: string;
  kind: ChatLastMessagePollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: ChatLastMessagePollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type ChatLastMessageSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type ChatLastMessageReplyToMedia = typeof ChatLastMessageReplyToMedia[keyof typeof ChatLastMessageReplyToMedia] | null;


export const ChatLastMessageReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type ChatLastMessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: ChatLastMessageReplyToMedia;
} | null;

export type ChatLastMessageForwardedFromKind = typeof ChatLastMessageForwardedFromKind[keyof typeof ChatLastMessageForwardedFromKind];


export const ChatLastMessageForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type ChatLastMessageForwardedFrom = {
  kind: ChatLastMessageForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type ChatLastMessage = {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: ChatLastMessageKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: ChatLastMessageAttachment;
  /** @nullable */
  sticker: ChatLastMessageSticker;
  reactions: ChatLastMessageReactionsItem[];
  /** @nullable */
  poll: ChatLastMessagePoll;
  /** @nullable */
  sender: ChatLastMessageSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: ChatLastMessageReplyTo;
  /** @nullable */
  forwardedFrom: ChatLastMessageForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
} | null;

export interface Chat {
  id: string;
  type: ChatType;
  /** @nullable */
  peer: ChatPeer;
  /** @nullable */
  group: ChatGroup;
  /** @nullable */
  lastMessage: ChatLastMessage;
  /** @minimum 0 */
  lastSeq: number;
  /** @minimum 0 */
  readSeq: number;
  /** @minimum 0 */
  unreadCount: number;
  markedUnread: boolean;
  /** @minimum 0 */
  peerReadSeq: number;
  /** @minimum 0 */
  peerDeliveredSeq: number;
  /** @nullable */
  mutedUntil: string | null;
  pinned: boolean;
  /** @nullable */
  pinnedAt: string | null;
  archived: boolean;
  folderIds: string[];
  /** @minimum 0 */
  scheduledCount: number;
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
}

export type MessagesResponseMessagesItemKind = typeof MessagesResponseMessagesItemKind[keyof typeof MessagesResponseMessagesItemKind];


export const MessagesResponseMessagesItemKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type MessagesResponseMessagesItemAttachmentKind = typeof MessagesResponseMessagesItemAttachmentKind[keyof typeof MessagesResponseMessagesItemAttachmentKind];


export const MessagesResponseMessagesItemAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemAttachment = {
  id: string;
  kind: MessagesResponseMessagesItemAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type MessagesResponseMessagesItemReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type MessagesResponseMessagesItemPollKind = typeof MessagesResponseMessagesItemPollKind[keyof typeof MessagesResponseMessagesItemPollKind];


export const MessagesResponseMessagesItemPollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type MessagesResponseMessagesItemPollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type MessagesResponseMessagesItemPoll = {
  id: string;
  question: string;
  kind: MessagesResponseMessagesItemPollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: MessagesResponseMessagesItemPollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemReplyToMedia = typeof MessagesResponseMessagesItemReplyToMedia[keyof typeof MessagesResponseMessagesItemReplyToMedia] | null;


export const MessagesResponseMessagesItemReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: MessagesResponseMessagesItemReplyToMedia;
} | null;

export type MessagesResponseMessagesItemForwardedFromKind = typeof MessagesResponseMessagesItemForwardedFromKind[keyof typeof MessagesResponseMessagesItemForwardedFromKind];


export const MessagesResponseMessagesItemForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemForwardedFrom = {
  kind: MessagesResponseMessagesItemForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

export type MessagesResponseMessagesItem = {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: MessagesResponseMessagesItemKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: MessagesResponseMessagesItemAttachment;
  /** @nullable */
  sticker: MessagesResponseMessagesItemSticker;
  reactions: MessagesResponseMessagesItemReactionsItem[];
  /** @nullable */
  poll: MessagesResponseMessagesItemPoll;
  /** @nullable */
  sender: MessagesResponseMessagesItemSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: MessagesResponseMessagesItemReplyTo;
  /** @nullable */
  forwardedFrom: MessagesResponseMessagesItemForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
};

export interface MessagesResponse {
  messages: MessagesResponseMessagesItem[];
}

export type SendMessageBodyPollKind = typeof SendMessageBodyPollKind[keyof typeof SendMessageBodyPollKind];


export const SendMessageBodyPollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type SendMessageBodyPoll = {
  /**
     * @minLength 1
     * @maxLength 300
     */
  question: string;
  /**
     * @minItems 2
     * @maxItems 10
     * @items.minLength 1
     * @items.maxLength 100
     */
  options: string[];
  kind?: SendMessageBodyPollKind;
  anonymous?: boolean;
  multiple?: boolean;
  /**
     * @minimum 0
     * @maximum 9
     */
  correctOption?: number;
  /**
     * @minLength 1
     * @maxLength 200
     */
  explanation?: string;
};

export interface SendMessageBody {
  clientId: string;
  /** @minLength 1 */
  text?: string;
  replyToId?: string;
  fileId?: string;
  stickerId?: string;
  /** @pattern ^[A-Za-z0-9]{1,64}$ */
  gifId?: string;
  poll?: SendMessageBodyPoll;
}

export type MessageKind = typeof MessageKind[keyof typeof MessageKind];


export const MessageKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type MessageAttachmentKind = typeof MessageAttachmentKind[keyof typeof MessageAttachmentKind];


export const MessageAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type MessageAttachment = {
  id: string;
  kind: MessageAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type MessageSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type MessageReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type MessagePollKind = typeof MessagePollKind[keyof typeof MessagePollKind];


export const MessagePollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type MessagePollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type MessagePoll = {
  id: string;
  question: string;
  kind: MessagePollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: MessagePollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type MessageSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type MessageReplyToMedia = typeof MessageReplyToMedia[keyof typeof MessageReplyToMedia] | null;


export const MessageReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type MessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: MessageReplyToMedia;
} | null;

export type MessageForwardedFromKind = typeof MessageForwardedFromKind[keyof typeof MessageForwardedFromKind];


export const MessageForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type MessageForwardedFrom = {
  kind: MessageForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

export interface Message {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: MessageKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: MessageAttachment;
  /** @nullable */
  sticker: MessageSticker;
  reactions: MessageReactionsItem[];
  /** @nullable */
  poll: MessagePoll;
  /** @nullable */
  sender: MessageSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: MessageReplyTo;
  /** @nullable */
  forwardedFrom: MessageForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
}

export interface ReadChatBody {
  /** @minimum 0 */
  seq: number;
}

export interface ChatStateBody {
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  /** @nullable */
  mutedUntil?: string | null;
}

export interface EditMessageBody {
  /** @minLength 1 */
  text: string;
}

export type DeleteMessagesBodyScope = typeof DeleteMessagesBodyScope[keyof typeof DeleteMessagesBodyScope];


export const DeleteMessagesBodyScope = {
  me: 'me',
  both: 'both',
} as const;

export interface DeleteMessagesBody {
  chatId: string;
  /**
     * @minItems 1
     * @maxItems 100
     */
  messageIds: string[];
  scope: DeleteMessagesBodyScope;
}

export type ForwardMessagesBodyTargetsItem = {
  chatId: string;
  clientId: string;
};

export interface ForwardMessagesBody {
  fromChatId: string;
  /**
     * @minItems 1
     * @maxItems 100
     */
  messageIds: string[];
  /**
     * @minItems 1
     * @maxItems 10
     */
  targets: ForwardMessagesBodyTargetsItem[];
}

export type FoldersResponseFoldersItem = {
  id: string;
  name: string;
  chatIds: string[];
};

export interface FoldersResponse {
  folders: FoldersResponseFoldersItem[];
}

export interface CreateFolderBody {
  /** @minLength 1 */
  name: string;
  /** @maxItems 200 */
  chatIds?: string[];
}

export interface UpdateFolderBody {
  /** @minLength 1 */
  name?: string;
  /** @maxItems 200 */
  chatIds?: string[];
}

export type ReportBodyReason = typeof ReportBodyReason[keyof typeof ReportBodyReason];


export const ReportBodyReason = {
  spam: 'spam',
  harassment: 'harassment',
  inappropriate_content: 'inappropriate_content',
  other: 'other',
} as const;

export interface ReportBody {
  userId: string;
  messageId?: string;
  reason: ReportBodyReason;
  /** @minLength 1 */
  details?: string;
}

export interface ScreenshotEventBody {
  chatId?: string;
  /** @pattern ^[a-z_]{1,40}$ */
  screen: string;
  /** @maxItems 100 */
  messageIds?: string[];
  occurredAt: string;
}

export type SyncResponseUpdatesItemKind = typeof SyncResponseUpdatesItemKind[keyof typeof SyncResponseUpdatesItemKind];


export const SyncResponseUpdatesItemKind = {
  messagenew: 'message.new',
  messageedited: 'message.edited',
  messagedeleted: 'message.deleted',
  messagehidden: 'message.hidden',
  messagepinned: 'message.pinned',
  messageunpinned: 'message.unpinned',
  messagereactions: 'message.reactions',
  chatread: 'chat.read',
  chatdelivered: 'chat.delivered',
  chatstate: 'chat.state',
  folders: 'folders',
  block: 'block',
  chatinfo: 'chat.info',
  chatmembers: 'chat.members',
  chatremoved: 'chat.removed',
  messagepoll: 'message.poll',
  scheduled: 'scheduled',
} as const;

export type SyncResponseUpdatesItemData = {[key: string]: unknown};

export type SyncResponseUpdatesItem = {
  /** @minimum 0 */
  seq: number;
  kind: SyncResponseUpdatesItemKind;
  /** @nullable */
  chatId: string | null;
  /** @nullable */
  messageId: string | null;
  data: SyncResponseUpdatesItemData;
};

export type SyncResponseChatsItemType = typeof SyncResponseChatsItemType[keyof typeof SyncResponseChatsItemType];


export const SyncResponseChatsItemType = {
  private: 'private',
  group: 'group',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemPeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemPeer = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  presence: SyncResponseChatsItemPeerPresence;
  blockedByMe: boolean;
  canMessage: boolean;
} | null;

export type SyncResponseChatsItemGroupRole = typeof SyncResponseChatsItemGroupRole[keyof typeof SyncResponseChatsItemGroupRole];


export const SyncResponseChatsItemGroupRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type SyncResponseChatsItemGroupAdminRightsItem = typeof SyncResponseChatsItemGroupAdminRightsItem[keyof typeof SyncResponseChatsItemGroupAdminRightsItem];


export const SyncResponseChatsItemGroupAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type SyncResponseChatsItemGroupPermissionsItem = typeof SyncResponseChatsItemGroupPermissionsItem[keyof typeof SyncResponseChatsItemGroupPermissionsItem];


export const SyncResponseChatsItemGroupPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type SyncResponseChatsItemGroupSettingsDefaultPermissionsItem = typeof SyncResponseChatsItemGroupSettingsDefaultPermissionsItem[keyof typeof SyncResponseChatsItemGroupSettingsDefaultPermissionsItem];


export const SyncResponseChatsItemGroupSettingsDefaultPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemGroupSettings = {
  defaultPermissions: SyncResponseChatsItemGroupSettingsDefaultPermissionsItem[];
  hideMemberCount: boolean;
  hideMemberList: boolean;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemGroup = {
  title: string;
  /** @nullable */
  description: string | null;
  /** @nullable */
  photoUrl: string | null;
  role: SyncResponseChatsItemGroupRole;
  adminRights: SyncResponseChatsItemGroupAdminRightsItem[];
  permissions: SyncResponseChatsItemGroupPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  restricted: boolean;
  /**
     * @minimum 0
     * @nullable
     */
  memberCount: number | null;
  canViewMembers: boolean;
  /** @nullable */
  settings: SyncResponseChatsItemGroupSettings;
  /**
     * @minimum 0
     * @nullable
     */
  pendingRequests: number | null;
  public: boolean;
} | null;

export type SyncResponseChatsItemLastMessageKind = typeof SyncResponseChatsItemLastMessageKind[keyof typeof SyncResponseChatsItemLastMessageKind];


export const SyncResponseChatsItemLastMessageKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type SyncResponseChatsItemLastMessageAttachmentKind = typeof SyncResponseChatsItemLastMessageAttachmentKind[keyof typeof SyncResponseChatsItemLastMessageAttachmentKind];


export const SyncResponseChatsItemLastMessageAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageAttachment = {
  id: string;
  kind: SyncResponseChatsItemLastMessageAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type SyncResponseChatsItemLastMessageReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type SyncResponseChatsItemLastMessagePollKind = typeof SyncResponseChatsItemLastMessagePollKind[keyof typeof SyncResponseChatsItemLastMessagePollKind];


export const SyncResponseChatsItemLastMessagePollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type SyncResponseChatsItemLastMessagePollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessagePoll = {
  id: string;
  question: string;
  kind: SyncResponseChatsItemLastMessagePollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: SyncResponseChatsItemLastMessagePollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageReplyToMedia = typeof SyncResponseChatsItemLastMessageReplyToMedia[keyof typeof SyncResponseChatsItemLastMessageReplyToMedia] | null;


export const SyncResponseChatsItemLastMessageReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: SyncResponseChatsItemLastMessageReplyToMedia;
} | null;

export type SyncResponseChatsItemLastMessageForwardedFromKind = typeof SyncResponseChatsItemLastMessageForwardedFromKind[keyof typeof SyncResponseChatsItemLastMessageForwardedFromKind];


export const SyncResponseChatsItemLastMessageForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageForwardedFrom = {
  kind: SyncResponseChatsItemLastMessageForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessage = {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: SyncResponseChatsItemLastMessageKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: SyncResponseChatsItemLastMessageAttachment;
  /** @nullable */
  sticker: SyncResponseChatsItemLastMessageSticker;
  reactions: SyncResponseChatsItemLastMessageReactionsItem[];
  /** @nullable */
  poll: SyncResponseChatsItemLastMessagePoll;
  /** @nullable */
  sender: SyncResponseChatsItemLastMessageSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: SyncResponseChatsItemLastMessageReplyTo;
  /** @nullable */
  forwardedFrom: SyncResponseChatsItemLastMessageForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
} | null;

export type SyncResponseChatsItem = {
  id: string;
  type: SyncResponseChatsItemType;
  /** @nullable */
  peer: SyncResponseChatsItemPeer;
  /** @nullable */
  group: SyncResponseChatsItemGroup;
  /** @nullable */
  lastMessage: SyncResponseChatsItemLastMessage;
  /** @minimum 0 */
  lastSeq: number;
  /** @minimum 0 */
  readSeq: number;
  /** @minimum 0 */
  unreadCount: number;
  markedUnread: boolean;
  /** @minimum 0 */
  peerReadSeq: number;
  /** @minimum 0 */
  peerDeliveredSeq: number;
  /** @nullable */
  mutedUntil: string | null;
  pinned: boolean;
  /** @nullable */
  pinnedAt: string | null;
  archived: boolean;
  folderIds: string[];
  /** @minimum 0 */
  scheduledCount: number;
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
};

export type SyncResponseMessagesItemKind = typeof SyncResponseMessagesItemKind[keyof typeof SyncResponseMessagesItemKind];


export const SyncResponseMessagesItemKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type SyncResponseMessagesItemAttachmentKind = typeof SyncResponseMessagesItemAttachmentKind[keyof typeof SyncResponseMessagesItemAttachmentKind];


export const SyncResponseMessagesItemAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type SyncResponseMessagesItemAttachment = {
  id: string;
  kind: SyncResponseMessagesItemAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseMessagesItemSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type SyncResponseMessagesItemReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type SyncResponseMessagesItemPollKind = typeof SyncResponseMessagesItemPollKind[keyof typeof SyncResponseMessagesItemPollKind];


export const SyncResponseMessagesItemPollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type SyncResponseMessagesItemPollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type SyncResponseMessagesItemPoll = {
  id: string;
  question: string;
  kind: SyncResponseMessagesItemPollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: SyncResponseMessagesItemPollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseMessagesItemSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type SyncResponseMessagesItemReplyToMedia = typeof SyncResponseMessagesItemReplyToMedia[keyof typeof SyncResponseMessagesItemReplyToMedia] | null;


export const SyncResponseMessagesItemReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type SyncResponseMessagesItemReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: SyncResponseMessagesItemReplyToMedia;
} | null;

export type SyncResponseMessagesItemForwardedFromKind = typeof SyncResponseMessagesItemForwardedFromKind[keyof typeof SyncResponseMessagesItemForwardedFromKind];


export const SyncResponseMessagesItemForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type SyncResponseMessagesItemForwardedFrom = {
  kind: SyncResponseMessagesItemForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

export type SyncResponseMessagesItem = {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: SyncResponseMessagesItemKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: SyncResponseMessagesItemAttachment;
  /** @nullable */
  sticker: SyncResponseMessagesItemSticker;
  reactions: SyncResponseMessagesItemReactionsItem[];
  /** @nullable */
  poll: SyncResponseMessagesItemPoll;
  /** @nullable */
  sender: SyncResponseMessagesItemSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: SyncResponseMessagesItemReplyTo;
  /** @nullable */
  forwardedFrom: SyncResponseMessagesItemForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
};

export type SyncResponseFoldersItem = {
  id: string;
  name: string;
  chatIds: string[];
};

export interface SyncResponse {
  /** @minimum 0 */
  seq: number;
  updates: SyncResponseUpdatesItem[];
  hasMore: boolean;
  resync: boolean;
  chats: SyncResponseChatsItem[];
  messages: SyncResponseMessagesItem[];
  /** @nullable */
  folders: SyncResponseFoldersItem[] | null;
}

export type RealtimeChannelResponseEvent = typeof RealtimeChannelResponseEvent[keyof typeof RealtimeChannelResponseEvent];


export const RealtimeChannelResponseEvent = {
  signal: 'signal',
} as const;

export interface RealtimeChannelResponse {
  enabled: boolean;
  /** @nullable */
  url: string | null;
  /** @nullable */
  apiKey: string | null;
  /** @nullable */
  accessToken: string | null;
  /** @nullable */
  topic: string | null;
  /** @nullable */
  expiresAt: string | null;
  /**
     * @minimum 0
     * @nullable
     */
  expiresInSeconds: number | null;
  event: RealtimeChannelResponseEvent;
  /** @exclusiveMinimum 0 */
  heartbeatSeconds: number;
}

export interface RealtimeHeartbeatResponse {
  /** @minimum 0 */
  seq: number;
}

export interface RealtimeTypingBody {
  chatId: string;
}

export type UploadRequestBodyKind = typeof UploadRequestBodyKind[keyof typeof UploadRequestBodyKind];


export const UploadRequestBodyKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
} as const;

export type UploadRequestBodyThumbnailMimeType = typeof UploadRequestBodyThumbnailMimeType[keyof typeof UploadRequestBodyThumbnailMimeType];


export const UploadRequestBodyThumbnailMimeType = {
  'image/jpeg': 'image/jpeg',
  'image/webp': 'image/webp',
} as const;

export type UploadRequestBodyThumbnail = {
  mimeType: UploadRequestBodyThumbnailMimeType;
  /**
     * @minimum 1
     * @maximum 204800
     */
  size: number;
};

export interface UploadRequestBody {
  chatId: string;
  kind: UploadRequestBodyKind;
  /**
     * @maxLength 100
     * @pattern ^[a-z0-9.+-]+\/[a-z0-9.+-]+$
     */
  mimeType: string;
  /**
     * @minimum 1
     * @maximum 52428800
     */
  size: number;
  /**
     * @minLength 1
     * @maxLength 255
     */
  fileName?: string;
  /**
     * @minimum 1
     * @maximum 20000
     */
  width?: number;
  /**
     * @minimum 1
     * @maximum 20000
     */
  height?: number;
  /**
     * @minimum 0
     * @maximum 86400000
     */
  durationMs?: number;
  /**
     * @minItems 1
     * @maxItems 100
     * @items.minimum 0
     * @items.maximum 100
     */
  waveform?: number[];
  thumbnail?: UploadRequestBodyThumbnail;
}

export type UploadResponseUploadMethod = typeof UploadResponseUploadMethod[keyof typeof UploadResponseUploadMethod];


export const UploadResponseUploadMethod = {
  PUT: 'PUT',
} as const;

export type UploadResponseUploadHeaders = {[key: string]: string};

export type UploadResponseUpload = {
  url: string;
  method: UploadResponseUploadMethod;
  headers: UploadResponseUploadHeaders;
};

export type UploadResponseThumbnailUploadMethod = typeof UploadResponseThumbnailUploadMethod[keyof typeof UploadResponseThumbnailUploadMethod];


export const UploadResponseThumbnailUploadMethod = {
  PUT: 'PUT',
} as const;

export type UploadResponseThumbnailUploadHeaders = {[key: string]: string};

/**
 * @nullable
 */
export type UploadResponseThumbnailUpload = {
  url: string;
  method: UploadResponseThumbnailUploadMethod;
  headers: UploadResponseThumbnailUploadHeaders;
} | null;

export interface UploadResponse {
  fileId: string;
  upload: UploadResponseUpload;
  /** @nullable */
  thumbnailUpload: UploadResponseThumbnailUpload;
  expiresAt: string;
}

export interface FileUrlResponse {
  url: string;
  /** @exclusiveMinimum 0 */
  expiresInSeconds: number;
}

export type ReactionBodyEmoji = typeof ReactionBodyEmoji[keyof typeof ReactionBodyEmoji];


export const ReactionBodyEmoji = {
  '👍': '👍',
  '❤️': '❤️',
  '😂': '😂',
  '😮': '😮',
  '😢': '😢',
  '🙏': '🙏',
  '🔥': '🔥',
  '👏': '👏',
  '🎉': '🎉',
  '👎': '👎',
} as const;

export interface ReactionBody {
  emoji: ReactionBodyEmoji;
}

export type StickerPacksResponsePacksItemStickersItem = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
};

export type StickerPacksResponsePacksItem = {
  id: string;
  name: string;
  stickers: StickerPacksResponsePacksItemStickersItem[];
};

export interface StickerPacksResponse {
  packs: StickerPacksResponsePacksItem[];
}

export type GifSearchResponseGifsItem = {
  id: string;
  title: string;
  width: number;
  height: number;
  previewUrl: string;
};

export interface GifSearchResponse {
  enabled: boolean;
  gifs: GifSearchResponseGifsItem[];
  /** @nullable */
  nextOffset: number | null;
}

export type AdminStickerPacksResponsePacksItemStickersItem = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
  removed: boolean;
};

export type AdminStickerPacksResponsePacksItem = {
  id: string;
  name: string;
  archived: boolean;
  createdAt: string;
  stickers: AdminStickerPacksResponsePacksItemStickersItem[];
};

export interface AdminStickerPacksResponse {
  packs: AdminStickerPacksResponsePacksItem[];
}

export type AdminStickerImageResponseMimeType = typeof AdminStickerImageResponseMimeType[keyof typeof AdminStickerImageResponseMimeType];


export const AdminStickerImageResponseMimeType = {
  'image/png': 'image/png',
  'image/webp': 'image/webp',
} as const;

export interface AdminStickerImageResponse {
  mimeType: AdminStickerImageResponseMimeType;
  data: string;
}

export interface CreateStickerPackBody {
  /**
     * @minLength 1
     * @maxLength 64
     */
  name: string;
}

export interface UpdateStickerPackBody {
  /**
     * @minLength 1
     * @maxLength 64
     */
  name?: string;
  archived?: boolean;
}

export interface AddStickerBody {
  /**
     * @minLength 1
     * @maxLength 16
     */
  emoji: string;
  /**
     * @minLength 8
     * @maxLength 699055
     */
  data: string;
}

export interface CreateGroupBody {
  /** @minLength 1 */
  title: string;
  description?: string;
  /** @maxItems 50 */
  memberIds?: string[];
}

export interface UpdateGroupBody {
  /** @minLength 1 */
  title?: string;
  description?: string;
}

export type GroupSettingsBodyDefaultPermissionsItem = typeof GroupSettingsBodyDefaultPermissionsItem[keyof typeof GroupSettingsBodyDefaultPermissionsItem];


export const GroupSettingsBodyDefaultPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export interface GroupSettingsBody {
  defaultPermissions?: GroupSettingsBodyDefaultPermissionsItem[];
  hideMemberCount?: boolean;
  hideMemberList?: boolean;
  isPublic?: boolean;
}

export type GroupMembersResponseMembersItemUser = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
};

export type GroupMembersResponseMembersItemRole = typeof GroupMembersResponseMembersItemRole[keyof typeof GroupMembersResponseMembersItemRole];


export const GroupMembersResponseMembersItemRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type GroupMembersResponseMembersItemAdminRightsItem = typeof GroupMembersResponseMembersItemAdminRightsItem[keyof typeof GroupMembersResponseMembersItemAdminRightsItem];


export const GroupMembersResponseMembersItemAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type GroupMembersResponseMembersItemDeniedPermissionsItem = typeof GroupMembersResponseMembersItemDeniedPermissionsItem[keyof typeof GroupMembersResponseMembersItemDeniedPermissionsItem];


export const GroupMembersResponseMembersItemDeniedPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type GroupMembersResponseMembersItem = {
  user: GroupMembersResponseMembersItemUser;
  role: GroupMembersResponseMembersItemRole;
  adminRights: GroupMembersResponseMembersItemAdminRightsItem[];
  deniedPermissions: GroupMembersResponseMembersItemDeniedPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  joinedAt: string;
};

export interface GroupMembersResponse {
  members: GroupMembersResponseMembersItem[];
  /**
     * @minimum 0
     * @nullable
     */
  count: number | null;
  /** @nullable */
  nextAfter: string | null;
}

export interface AddMembersBody {
  /** @maxItems 50 */
  userIds: string[];
}

export interface AddMembersResponse {
  added: string[];
  notAdded: string[];
}

export type UpdateMemberBodyRole = typeof UpdateMemberBodyRole[keyof typeof UpdateMemberBodyRole];


export const UpdateMemberBodyRole = {
  admin: 'admin',
  member: 'member',
} as const;

export type UpdateMemberBodyAdminRightsItem = typeof UpdateMemberBodyAdminRightsItem[keyof typeof UpdateMemberBodyAdminRightsItem];


export const UpdateMemberBodyAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type UpdateMemberBodyDeniedPermissionsItem = typeof UpdateMemberBodyDeniedPermissionsItem[keyof typeof UpdateMemberBodyDeniedPermissionsItem];


export const UpdateMemberBodyDeniedPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export interface UpdateMemberBody {
  role?: UpdateMemberBodyRole;
  adminRights?: UpdateMemberBodyAdminRightsItem[];
  deniedPermissions?: UpdateMemberBodyDeniedPermissionsItem[];
  /** @nullable */
  restrictedUntil?: string | null;
}

export interface TransferOwnershipBody {
  userId: string;
}

export type InviteLinksResponseLinksItem = {
  id: string;
  code: string;
  /** @nullable */
  name: string | null;
  createdAt: string;
  /** @nullable */
  expiresAt: string | null;
  /** @nullable */
  usageLimit: number | null;
  usageCount: number;
  requiresApproval: boolean;
  revoked: boolean;
};

export interface InviteLinksResponse {
  links: InviteLinksResponseLinksItem[];
}

export interface CreateInviteLinkBody {
  /**
     * @minLength 1
     * @maxLength 32
     */
  name?: string;
  expiresAt?: string;
  /**
     * @minimum 1
     * @maximum 100000
     */
  usageLimit?: number;
  requiresApproval?: boolean;
}

export interface InviteLink {
  id: string;
  code: string;
  /** @nullable */
  name: string | null;
  createdAt: string;
  /** @nullable */
  expiresAt: string | null;
  /** @nullable */
  usageLimit: number | null;
  usageCount: number;
  requiresApproval: boolean;
  revoked: boolean;
}

export type JoinRequestsResponseRequestsItemUser = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
};

export type JoinRequestsResponseRequestsItem = {
  id: string;
  user: JoinRequestsResponseRequestsItemUser;
  requestedAt: string;
};

export interface JoinRequestsResponse {
  requests: JoinRequestsResponseRequestsItem[];
}

export type InvitePreviewType = typeof InvitePreviewType[keyof typeof InvitePreviewType];


export const InvitePreviewType = {
  group: 'group',
  channel: 'channel',
} as const;

export interface InvitePreview {
  type: InvitePreviewType;
  title: string;
  /** @nullable */
  description: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @nullable */
  memberCount: number | null;
  requiresApproval: boolean;
  /** @nullable */
  chatId: string | null;
  requested: boolean;
}

export type JoinResponseStatus = typeof JoinResponseStatus[keyof typeof JoinResponseStatus];


export const JoinResponseStatus = {
  joined: 'joined',
  requested: 'requested',
} as const;

export interface JoinResponse {
  status: JoinResponseStatus;
  /** @nullable */
  chatId: string | null;
}

export interface PollVoteBody {
  /**
     * @minItems 1
     * @maxItems 10
     * @items.minimum 0
     * @items.maximum 9
     */
  options: number[];
}

export type PollVotersResponseOptionsItemVotersItem = {
  id: string;
  deleted: boolean;
  displayName: string;
  /** @nullable */
  username: string | null;
  /** @nullable */
  bio: string | null;
  /** @nullable */
  photoUrl: string | null;
};

export type PollVotersResponseOptionsItem = {
  voters: PollVotersResponseOptionsItemVotersItem[];
};

export interface PollVotersResponse {
  options: PollVotersResponseOptionsItem[];
}

export interface UserPermissions {
  createGroups: boolean;
  createChannels: boolean;
  scheduleMessages: boolean;
}

export type AdminUserPermissionsResponseUser = {
  id: string;
  phone: string;
  /** @nullable */
  name: string | null;
  status: string;
};

export type AdminUserPermissionsResponsePermissions = {
  createGroups: boolean;
  createChannels: boolean;
  scheduleMessages: boolean;
};

export interface AdminUserPermissionsResponse {
  user: AdminUserPermissionsResponseUser;
  permissions: AdminUserPermissionsResponsePermissions;
}

export interface AdminUserPermissionsBody {
  createGroups: boolean;
  createChannels: boolean;
  scheduleMessages: boolean;
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
}

export interface CreateChannelBody {
  /** @minLength 1 */
  title: string;
  description?: string;
  isPublic?: boolean;
}

export type ChannelSearchResponseChannelsItem = {
  id: string;
  title: string;
  /** @nullable */
  description: string | null;
  /** @nullable */
  photoUrl: string | null;
  /** @minimum 0 */
  subscriberCount: number;
  subscribed: boolean;
};

export interface ChannelSearchResponse {
  channels: ChannelSearchResponseChannelsItem[];
}

export type ScheduleMessageBodyMessagePollKind = typeof ScheduleMessageBodyMessagePollKind[keyof typeof ScheduleMessageBodyMessagePollKind];


export const ScheduleMessageBodyMessagePollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type ScheduleMessageBodyMessagePoll = {
  /**
     * @minLength 1
     * @maxLength 300
     */
  question: string;
  /**
     * @minItems 2
     * @maxItems 10
     * @items.minLength 1
     * @items.maxLength 100
     */
  options: string[];
  kind?: ScheduleMessageBodyMessagePollKind;
  anonymous?: boolean;
  multiple?: boolean;
  /**
     * @minimum 0
     * @maximum 9
     */
  correctOption?: number;
  /**
     * @minLength 1
     * @maxLength 200
     */
  explanation?: string;
};

export type ScheduleMessageBodyMessage = {
  clientId: string;
  /** @minLength 1 */
  text?: string;
  replyToId?: string;
  fileId?: string;
  stickerId?: string;
  /** @pattern ^[A-Za-z0-9]{1,64}$ */
  gifId?: string;
  poll?: ScheduleMessageBodyMessagePoll;
};

export interface ScheduleMessageBody {
  sendAt: string;
  message: ScheduleMessageBodyMessage;
}

export type ScheduledMessageStatus = typeof ScheduledMessageStatus[keyof typeof ScheduledMessageStatus];


export const ScheduledMessageStatus = {
  pending: 'pending',
  failed: 'failed',
} as const;

/**
 * @nullable
 */
export type ScheduledMessageMedia = typeof ScheduledMessageMedia[keyof typeof ScheduledMessageMedia] | null;


export const ScheduledMessageMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export interface ScheduledMessage {
  id: string;
  chatId: string;
  clientId: string;
  sendAt: string;
  status: ScheduledMessageStatus;
  /** @nullable */
  error: string | null;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: ScheduledMessageMedia;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  pollQuestion: string | null;
  /** @nullable */
  replyToId: string | null;
  createdAt: string;
}

export type ScheduledMessagesResponseScheduledItemStatus = typeof ScheduledMessagesResponseScheduledItemStatus[keyof typeof ScheduledMessagesResponseScheduledItemStatus];


export const ScheduledMessagesResponseScheduledItemStatus = {
  pending: 'pending',
  failed: 'failed',
} as const;

/**
 * @nullable
 */
export type ScheduledMessagesResponseScheduledItemMedia = typeof ScheduledMessagesResponseScheduledItemMedia[keyof typeof ScheduledMessagesResponseScheduledItemMedia] | null;


export const ScheduledMessagesResponseScheduledItemMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type ScheduledMessagesResponseScheduledItem = {
  id: string;
  chatId: string;
  clientId: string;
  sendAt: string;
  status: ScheduledMessagesResponseScheduledItemStatus;
  /** @nullable */
  error: string | null;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: ScheduledMessagesResponseScheduledItemMedia;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  pollQuestion: string | null;
  /** @nullable */
  replyToId: string | null;
  createdAt: string;
};

export interface ScheduledMessagesResponse {
  scheduled: ScheduledMessagesResponseScheduledItem[];
}

export interface UpdateScheduledBody {
  sendAt?: string;
  /** @minLength 1 */
  text?: string;
}

export interface DispatchResponse {
  sent: number;
  failed: number;
}

export interface NotificationSettings {
  privateChats: boolean;
  groups: boolean;
  channels: boolean;
  previews: boolean;
}

export interface UpdateNotificationSettingsBody {
  privateChats?: boolean;
  groups?: boolean;
  channels?: boolean;
  previews?: boolean;
}

export interface BadgeResponse {
  /** @minimum 0 */
  count: number;
}

export interface ViewingBody {
  /** @nullable */
  chatId: string | null;
}

export type GlobalSearchResponseMessagesItemKind = typeof GlobalSearchResponseMessagesItemKind[keyof typeof GlobalSearchResponseMessagesItemKind];


export const GlobalSearchResponseMessagesItemKind = {
  text: 'text',
  media: 'media',
  sticker: 'sticker',
  poll: 'poll',
} as const;

export type GlobalSearchResponseMessagesItemAttachmentKind = typeof GlobalSearchResponseMessagesItemAttachmentKind[keyof typeof GlobalSearchResponseMessagesItemAttachmentKind];


export const GlobalSearchResponseMessagesItemAttachmentKind = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
} as const;

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemAttachment = {
  id: string;
  kind: GlobalSearchResponseMessagesItemAttachmentKind;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @nullable */
  fileName: string | null;
  /** @nullable */
  width: number | null;
  /** @nullable */
  height: number | null;
  /** @nullable */
  durationMs: number | null;
  /** @nullable */
  waveform: number[] | null;
  /** @nullable */
  thumbnailUrl: string | null;
} | null;

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemSticker = {
  id: string;
  packId: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
} | null;

export type GlobalSearchResponseMessagesItemReactionsItem = {
  emoji: string;
  /** @exclusiveMinimum 0 */
  count: number;
  mine: boolean;
};

export type GlobalSearchResponseMessagesItemPollKind = typeof GlobalSearchResponseMessagesItemPollKind[keyof typeof GlobalSearchResponseMessagesItemPollKind];


export const GlobalSearchResponseMessagesItemPollKind = {
  regular: 'regular',
  quiz: 'quiz',
} as const;

export type GlobalSearchResponseMessagesItemPollOptionsItem = {
  text: string;
  /** @nullable */
  votes: number | null;
};

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemPoll = {
  id: string;
  question: string;
  kind: GlobalSearchResponseMessagesItemPollKind;
  anonymous: boolean;
  multiple: boolean;
  closed: boolean;
  options: GlobalSearchResponseMessagesItemPollOptionsItem[];
  /** @nullable */
  totalVoters: number | null;
  /** @nullable */
  myVotes: number[] | null;
  /** @nullable */
  correctOption: number | null;
  /** @nullable */
  explanation: string | null;
} | null;

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemSender = {
  id: string;
  displayName: string;
  /** @nullable */
  photoUrl: string | null;
  deleted: boolean;
} | null;

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemReplyToMedia = typeof GlobalSearchResponseMessagesItemReplyToMedia[keyof typeof GlobalSearchResponseMessagesItemReplyToMedia] | null;


export const GlobalSearchResponseMessagesItemReplyToMedia = {
  photo: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  video_note: 'video_note',
  file: 'file',
  gif: 'gif',
  sticker: 'sticker',
  poll: 'poll',
} as const;

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
  /** @nullable */
  media: GlobalSearchResponseMessagesItemReplyToMedia;
} | null;

export type GlobalSearchResponseMessagesItemForwardedFromKind = typeof GlobalSearchResponseMessagesItemForwardedFromKind[keyof typeof GlobalSearchResponseMessagesItemForwardedFromKind];


export const GlobalSearchResponseMessagesItemForwardedFromKind = {
  user: 'user',
  channel: 'channel',
} as const;

/**
 * @nullable
 */
export type GlobalSearchResponseMessagesItemForwardedFrom = {
  kind: GlobalSearchResponseMessagesItemForwardedFromKind;
  id: string;
  displayName: string;
  deleted: boolean;
} | null;

export type GlobalSearchResponseMessagesItem = {
  id: string;
  chatId: string;
  /** @minimum 0 */
  seq: number;
  senderId: string;
  clientId: string;
  kind: GlobalSearchResponseMessagesItemKind;
  /** @nullable */
  text: string | null;
  deleted: boolean;
  /** @nullable */
  attachment: GlobalSearchResponseMessagesItemAttachment;
  /** @nullable */
  sticker: GlobalSearchResponseMessagesItemSticker;
  reactions: GlobalSearchResponseMessagesItemReactionsItem[];
  /** @nullable */
  poll: GlobalSearchResponseMessagesItemPoll;
  /** @nullable */
  sender: GlobalSearchResponseMessagesItemSender;
  mentionsMe: boolean;
  /** @nullable */
  replyTo: GlobalSearchResponseMessagesItemReplyTo;
  /** @nullable */
  forwardedFrom: GlobalSearchResponseMessagesItemForwardedFrom;
  createdAt: string;
  /** @nullable */
  editedAt: string | null;
};

export interface GlobalSearchResponse {
  messages: GlobalSearchResponseMessagesItem[];
  /** @nullable */
  nextCursor: string | null;
}

export type AdminStatsUsers = {
  total: number;
  active: number;
  suspended: number;
  banned: number;
  deletionRequested: number;
  deleted: number;
};

export type AdminStatsMessages = {
  last24h: number;
  last7Days: number;
};

export interface AdminStats {
  users: AdminStatsUsers;
  onlineNow: number;
  activeLast24h: number;
  messages: AdminStatsMessages;
  groups: number;
  channels: number;
  openReports: number;
  pendingDeletionRequests: number;
  activeSessions: number;
  pushDevices: number;
  pendingScheduledMessages: number;
}

export type AdminUsersResponseUsersItemStatus = typeof AdminUsersResponseUsersItemStatus[keyof typeof AdminUsersResponseUsersItemStatus];


export const AdminUsersResponseUsersItemStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminUsersResponseUsersItem = {
  id: string;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  status: AdminUsersResponseUsersItemStatus;
  createdAt: string;
  /** @nullable */
  lastSeenAt: string | null;
};

export interface AdminUsersResponse {
  users: AdminUsersResponseUsersItem[];
  /** @nullable */
  nextCursor: string | null;
}

export type AdminUserDetailUserStatus = typeof AdminUserDetailUserStatus[keyof typeof AdminUserDetailUserStatus];


export const AdminUserDetailUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminUserDetailUser = {
  id: string;
  /** @nullable */
  phone: string | null;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  status: AdminUserDetailUserStatus;
  createdAt: string;
  /** @nullable */
  lastSeenAt: string | null;
  /** @nullable */
  bio: string | null;
};

export type AdminUserDetailPermissions = {
  createGroups: boolean;
  createChannels: boolean;
  scheduleMessages: boolean;
};

export type AdminUserDetailSessionsItem = {
  id: string;
  /** @nullable */
  deviceName: string | null;
  platform: string;
  createdAt: string;
  lastUsedAt: string;
  /** @nullable */
  ip: string | null;
};

export type AdminUserDetailCounts = {
  groups: number;
  channels: number;
  messagesSent: number;
  reportsAgainst: number;
  reportsMade: number;
};

/**
 * @nullable
 */
export type AdminUserDetailDeletionRequest = {
  id: string;
  status: string;
  requestedAt: string;
} | null;

export type AdminUserDetailAccountEventsItem = {
  at: string;
  event: string;
  /** @nullable */
  detail: string | null;
};

export interface AdminUserDetail {
  user: AdminUserDetailUser;
  twoStepEnabled: boolean;
  permissions: AdminUserDetailPermissions;
  sessions: AdminUserDetailSessionsItem[];
  counts: AdminUserDetailCounts;
  /** @nullable */
  deletionRequest: AdminUserDetailDeletionRequest;
  accountEvents: AdminUserDetailAccountEventsItem[];
}

export type AdminUserActionBodyAction = typeof AdminUserActionBodyAction[keyof typeof AdminUserActionBodyAction];


export const AdminUserActionBodyAction = {
  suspend: 'suspend',
  ban: 'ban',
  reactivate: 'reactivate',
  end_sessions: 'end_sessions',
  delete: 'delete',
} as const;

export interface AdminUserActionBody {
  action: AdminUserActionBodyAction;
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export type AdminChatsResponseChatsItemType = typeof AdminChatsResponseChatsItemType[keyof typeof AdminChatsResponseChatsItemType];


export const AdminChatsResponseChatsItemType = {
  group: 'group',
  channel: 'channel',
} as const;

export type AdminChatsResponseChatsItemOwnerStatus = typeof AdminChatsResponseChatsItemOwnerStatus[keyof typeof AdminChatsResponseChatsItemOwnerStatus];


export const AdminChatsResponseChatsItemOwnerStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

/**
 * @nullable
 */
export type AdminChatsResponseChatsItemOwner = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminChatsResponseChatsItemOwnerStatus;
} | null;

export type AdminChatsResponseChatsItem = {
  id: string;
  type: AdminChatsResponseChatsItemType;
  title: string;
  public: boolean;
  memberCount: number;
  /** @nullable */
  owner: AdminChatsResponseChatsItemOwner;
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
  deleted: boolean;
};

export interface AdminChatsResponse {
  chats: AdminChatsResponseChatsItem[];
  /** @nullable */
  nextCursor: string | null;
}

export type AdminCreateChatBodyType = typeof AdminCreateChatBodyType[keyof typeof AdminCreateChatBodyType];


export const AdminCreateChatBodyType = {
  group: 'group',
  channel: 'channel',
} as const;

export interface AdminCreateChatBody {
  type: AdminCreateChatBodyType;
  /** @minLength 1 */
  title: string;
  description?: string;
  ownerUserId: string;
  isPublic?: boolean;
  /** @maxItems 50 */
  memberIds?: string[];
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export type AdminChatDetailType = typeof AdminChatDetailType[keyof typeof AdminChatDetailType];


export const AdminChatDetailType = {
  group: 'group',
  channel: 'channel',
} as const;

export type AdminChatDetailOwnerStatus = typeof AdminChatDetailOwnerStatus[keyof typeof AdminChatDetailOwnerStatus];


export const AdminChatDetailOwnerStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

/**
 * @nullable
 */
export type AdminChatDetailOwner = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminChatDetailOwnerStatus;
} | null;

export type AdminChatDetailSettingsDefaultPermissionsItem = typeof AdminChatDetailSettingsDefaultPermissionsItem[keyof typeof AdminChatDetailSettingsDefaultPermissionsItem];


export const AdminChatDetailSettingsDefaultPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type AdminChatDetailSettings = {
  defaultPermissions: AdminChatDetailSettingsDefaultPermissionsItem[];
  hideMemberCount: boolean;
  hideMemberList: boolean;
};

export type AdminChatDetailAdminsItemUserStatus = typeof AdminChatDetailAdminsItemUserStatus[keyof typeof AdminChatDetailAdminsItemUserStatus];


export const AdminChatDetailAdminsItemUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminChatDetailAdminsItemUser = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminChatDetailAdminsItemUserStatus;
};

export type AdminChatDetailAdminsItemRole = typeof AdminChatDetailAdminsItemRole[keyof typeof AdminChatDetailAdminsItemRole];


export const AdminChatDetailAdminsItemRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type AdminChatDetailAdminsItemAdminRightsItem = typeof AdminChatDetailAdminsItemAdminRightsItem[keyof typeof AdminChatDetailAdminsItemAdminRightsItem];


export const AdminChatDetailAdminsItemAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type AdminChatDetailAdminsItemDeniedPermissionsItem = typeof AdminChatDetailAdminsItemDeniedPermissionsItem[keyof typeof AdminChatDetailAdminsItemDeniedPermissionsItem];


export const AdminChatDetailAdminsItemDeniedPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type AdminChatDetailAdminsItem = {
  user: AdminChatDetailAdminsItemUser;
  role: AdminChatDetailAdminsItemRole;
  adminRights: AdminChatDetailAdminsItemAdminRightsItem[];
  deniedPermissions: AdminChatDetailAdminsItemDeniedPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  joinedAt: string;
};

export interface AdminChatDetail {
  id: string;
  type: AdminChatDetailType;
  title: string;
  public: boolean;
  memberCount: number;
  /** @nullable */
  owner: AdminChatDetailOwner;
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
  deleted: boolean;
  /** @nullable */
  description: string | null;
  settings: AdminChatDetailSettings;
  admins: AdminChatDetailAdminsItem[];
}

export type AdminUpdateChatBodyDefaultPermissionsItem = typeof AdminUpdateChatBodyDefaultPermissionsItem[keyof typeof AdminUpdateChatBodyDefaultPermissionsItem];


export const AdminUpdateChatBodyDefaultPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export interface AdminUpdateChatBody {
  /** @minLength 1 */
  title?: string;
  description?: string;
  isPublic?: boolean;
  defaultPermissions?: AdminUpdateChatBodyDefaultPermissionsItem[];
  hideMemberCount?: boolean;
  hideMemberList?: boolean;
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export interface AdminChatReasonBody {
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export type AdminChatMembersResponseMembersItemUserStatus = typeof AdminChatMembersResponseMembersItemUserStatus[keyof typeof AdminChatMembersResponseMembersItemUserStatus];


export const AdminChatMembersResponseMembersItemUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminChatMembersResponseMembersItemUser = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminChatMembersResponseMembersItemUserStatus;
};

export type AdminChatMembersResponseMembersItemRole = typeof AdminChatMembersResponseMembersItemRole[keyof typeof AdminChatMembersResponseMembersItemRole];


export const AdminChatMembersResponseMembersItemRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type AdminChatMembersResponseMembersItemAdminRightsItem = typeof AdminChatMembersResponseMembersItemAdminRightsItem[keyof typeof AdminChatMembersResponseMembersItemAdminRightsItem];


export const AdminChatMembersResponseMembersItemAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type AdminChatMembersResponseMembersItemDeniedPermissionsItem = typeof AdminChatMembersResponseMembersItemDeniedPermissionsItem[keyof typeof AdminChatMembersResponseMembersItemDeniedPermissionsItem];


export const AdminChatMembersResponseMembersItemDeniedPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export type AdminChatMembersResponseMembersItem = {
  user: AdminChatMembersResponseMembersItemUser;
  role: AdminChatMembersResponseMembersItemRole;
  adminRights: AdminChatMembersResponseMembersItemAdminRightsItem[];
  deniedPermissions: AdminChatMembersResponseMembersItemDeniedPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  joinedAt: string;
};

export interface AdminChatMembersResponse {
  members: AdminChatMembersResponseMembersItem[];
  /** @nullable */
  nextAfter: string | null;
}

export interface AdminAddChatMembersBody {
  /**
     * @minItems 1
     * @maxItems 50
     */
  userIds: string[];
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export type AdminUpdateChatMemberBodyRole = typeof AdminUpdateChatMemberBodyRole[keyof typeof AdminUpdateChatMemberBodyRole];


export const AdminUpdateChatMemberBodyRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
} as const;

export type AdminUpdateChatMemberBodyAdminRightsItem = typeof AdminUpdateChatMemberBodyAdminRightsItem[keyof typeof AdminUpdateChatMemberBodyAdminRightsItem];


export const AdminUpdateChatMemberBodyAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type AdminUpdateChatMemberBodyDeniedPermissionsItem = typeof AdminUpdateChatMemberBodyDeniedPermissionsItem[keyof typeof AdminUpdateChatMemberBodyDeniedPermissionsItem];


export const AdminUpdateChatMemberBodyDeniedPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export interface AdminUpdateChatMemberBody {
  role?: AdminUpdateChatMemberBodyRole;
  adminRights?: AdminUpdateChatMemberBodyAdminRightsItem[];
  deniedPermissions?: AdminUpdateChatMemberBodyDeniedPermissionsItem[];
  /** @nullable */
  restrictedUntil?: string | null;
  /**
     * @minLength 3
     * @maxLength 500
     */
  reason: string;
}

export type AdminChatMemberUserStatus = typeof AdminChatMemberUserStatus[keyof typeof AdminChatMemberUserStatus];


export const AdminChatMemberUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminChatMemberUser = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminChatMemberUserStatus;
};

export type AdminChatMemberRole = typeof AdminChatMemberRole[keyof typeof AdminChatMemberRole];


export const AdminChatMemberRole = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
  subscriber: 'subscriber',
} as const;

export type AdminChatMemberAdminRightsItem = typeof AdminChatMemberAdminRightsItem[keyof typeof AdminChatMemberAdminRightsItem];


export const AdminChatMemberAdminRightsItem = {
  change_info: 'change_info',
  delete_messages: 'delete_messages',
  restrict_members: 'restrict_members',
  invite_users: 'invite_users',
  approve_requests: 'approve_requests',
  pin_messages: 'pin_messages',
  manage_admins: 'manage_admins',
  change_privacy: 'change_privacy',
  post_messages: 'post_messages',
} as const;

export type AdminChatMemberDeniedPermissionsItem = typeof AdminChatMemberDeniedPermissionsItem[keyof typeof AdminChatMemberDeniedPermissionsItem];


export const AdminChatMemberDeniedPermissionsItem = {
  send_messages: 'send_messages',
  send_media: 'send_media',
  send_stickers: 'send_stickers',
  send_polls: 'send_polls',
  add_members: 'add_members',
  pin_messages: 'pin_messages',
  change_info: 'change_info',
} as const;

export interface AdminChatMember {
  user: AdminChatMemberUser;
  role: AdminChatMemberRole;
  adminRights: AdminChatMemberAdminRightsItem[];
  deniedPermissions: AdminChatMemberDeniedPermissionsItem[];
  /** @nullable */
  restrictedUntil: string | null;
  joinedAt: string;
}

export type AdminReportsResponseReportsItemReporterStatus = typeof AdminReportsResponseReportsItemReporterStatus[keyof typeof AdminReportsResponseReportsItemReporterStatus];


export const AdminReportsResponseReportsItemReporterStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminReportsResponseReportsItemReporter = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminReportsResponseReportsItemReporterStatus;
};

export type AdminReportsResponseReportsItemReportedUserStatus = typeof AdminReportsResponseReportsItemReportedUserStatus[keyof typeof AdminReportsResponseReportsItemReportedUserStatus];


export const AdminReportsResponseReportsItemReportedUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminReportsResponseReportsItemReportedUser = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminReportsResponseReportsItemReportedUserStatus;
};

/**
 * @nullable
 */
export type AdminReportsResponseReportsItemChat = {
  id: string;
  type: string;
  /** @nullable */
  title: string | null;
} | null;

/**
 * @nullable
 */
export type AdminReportsResponseReportsItemMessage = {
  id: string;
  /** @nullable */
  reportedText: string | null;
  /** @nullable */
  currentText: string | null;
  kind: string;
  /** @nullable */
  attachmentKind: string | null;
  deleted: boolean;
  removedByAdmin: boolean;
  sentAt: string;
} | null;

export type AdminReportsResponseReportsItemDecisionDecision = typeof AdminReportsResponseReportsItemDecisionDecision[keyof typeof AdminReportsResponseReportsItemDecisionDecision];


export const AdminReportsResponseReportsItemDecisionDecision = {
  dismissed: 'dismissed',
  message_removed: 'message_removed',
  user_suspended: 'user_suspended',
  user_banned: 'user_banned',
} as const;

/**
 * @nullable
 */
export type AdminReportsResponseReportsItemDecision = {
  decision: AdminReportsResponseReportsItemDecisionDecision;
  /** @nullable */
  note: string | null;
  admin: string;
  decidedAt: string;
} | null;

export type AdminReportsResponseReportsItem = {
  id: string;
  reason: string;
  /** @nullable */
  details: string | null;
  createdAt: string;
  reporter: AdminReportsResponseReportsItemReporter;
  reportedUser: AdminReportsResponseReportsItemReportedUser;
  /** @nullable */
  chat: AdminReportsResponseReportsItemChat;
  /** @nullable */
  message: AdminReportsResponseReportsItemMessage;
  /** @nullable */
  decision: AdminReportsResponseReportsItemDecision;
  otherReports: number;
};

export interface AdminReportsResponse {
  reports: AdminReportsResponseReportsItem[];
  /** @nullable */
  nextCursor: string | null;
}

export type AdminDecideReportBodyDecision = typeof AdminDecideReportBodyDecision[keyof typeof AdminDecideReportBodyDecision];


export const AdminDecideReportBodyDecision = {
  dismissed: 'dismissed',
  message_removed: 'message_removed',
  user_suspended: 'user_suspended',
  user_banned: 'user_banned',
} as const;

export interface AdminDecideReportBody {
  decision: AdminDecideReportBodyDecision;
  /**
     * @minLength 1
     * @maxLength 500
     */
  note?: string;
}

export type AdminReportReporterStatus = typeof AdminReportReporterStatus[keyof typeof AdminReportReporterStatus];


export const AdminReportReporterStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminReportReporter = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminReportReporterStatus;
};

export type AdminReportReportedUserStatus = typeof AdminReportReportedUserStatus[keyof typeof AdminReportReportedUserStatus];


export const AdminReportReportedUserStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminReportReportedUser = {
  id: string;
  /** @nullable */
  name: string | null;
  /** @nullable */
  username: string | null;
  /** @nullable */
  phone: string | null;
  status: AdminReportReportedUserStatus;
};

/**
 * @nullable
 */
export type AdminReportChat = {
  id: string;
  type: string;
  /** @nullable */
  title: string | null;
} | null;

/**
 * @nullable
 */
export type AdminReportMessage = {
  id: string;
  /** @nullable */
  reportedText: string | null;
  /** @nullable */
  currentText: string | null;
  kind: string;
  /** @nullable */
  attachmentKind: string | null;
  deleted: boolean;
  removedByAdmin: boolean;
  sentAt: string;
} | null;

export type AdminReportDecisionDecision = typeof AdminReportDecisionDecision[keyof typeof AdminReportDecisionDecision];


export const AdminReportDecisionDecision = {
  dismissed: 'dismissed',
  message_removed: 'message_removed',
  user_suspended: 'user_suspended',
  user_banned: 'user_banned',
} as const;

/**
 * @nullable
 */
export type AdminReportDecision = {
  decision: AdminReportDecisionDecision;
  /** @nullable */
  note: string | null;
  admin: string;
  decidedAt: string;
} | null;

export interface AdminReport {
  id: string;
  reason: string;
  /** @nullable */
  details: string | null;
  createdAt: string;
  reporter: AdminReportReporter;
  reportedUser: AdminReportReportedUser;
  /** @nullable */
  chat: AdminReportChat;
  /** @nullable */
  message: AdminReportMessage;
  /** @nullable */
  decision: AdminReportDecision;
  otherReports: number;
}

export type AdminAuditResponseEntriesItem = {
  at: string;
  event: string;
  /** @nullable */
  actor: string | null;
  /** @nullable */
  subject: string | null;
  /** @nullable */
  detail: string | null;
};

export interface AdminAuditResponse {
  entries: AdminAuditResponseEntriesItem[];
  /** @nullable */
  nextCursor: string | null;
}

export type AdminBroadcastsResponseBroadcastsItemAudience = typeof AdminBroadcastsResponseBroadcastsItemAudience[keyof typeof AdminBroadcastsResponseBroadcastsItemAudience];


export const AdminBroadcastsResponseBroadcastsItemAudience = {
  all: 'all',
  chat: 'chat',
} as const;

/**
 * @nullable
 */
export type AdminBroadcastsResponseBroadcastsItemChat = {
  id: string;
  /** @nullable */
  title: string | null;
} | null;

export type AdminBroadcastsResponseBroadcastsItemStatus = typeof AdminBroadcastsResponseBroadcastsItemStatus[keyof typeof AdminBroadcastsResponseBroadcastsItemStatus];


export const AdminBroadcastsResponseBroadcastsItemStatus = {
  sending: 'sending',
  sent: 'sent',
} as const;

export type AdminBroadcastsResponseBroadcastsItem = {
  id: string;
  title: string;
  body: string;
  audience: AdminBroadcastsResponseBroadcastsItemAudience;
  /** @nullable */
  chat: AdminBroadcastsResponseBroadcastsItemChat;
  status: AdminBroadcastsResponseBroadcastsItemStatus;
  devices: number;
  admin: string;
  createdAt: string;
  /** @nullable */
  finishedAt: string | null;
};

export interface AdminBroadcastsResponse {
  broadcasts: AdminBroadcastsResponseBroadcastsItem[];
}

export type AdminBroadcastBodyAudience = typeof AdminBroadcastBodyAudience[keyof typeof AdminBroadcastBodyAudience];


export const AdminBroadcastBodyAudience = {
  all: 'all',
  chat: 'chat',
} as const;

export interface AdminBroadcastBody {
  /**
     * @minLength 1
     * @maxLength 100
     */
  title: string;
  /**
     * @minLength 1
     * @maxLength 300
     */
  body: string;
  audience: AdminBroadcastBodyAudience;
  chatId?: string;
}

export type AdminBroadcastAudience = typeof AdminBroadcastAudience[keyof typeof AdminBroadcastAudience];


export const AdminBroadcastAudience = {
  all: 'all',
  chat: 'chat',
} as const;

/**
 * @nullable
 */
export type AdminBroadcastChat = {
  id: string;
  /** @nullable */
  title: string | null;
} | null;

export type AdminBroadcastStatus = typeof AdminBroadcastStatus[keyof typeof AdminBroadcastStatus];


export const AdminBroadcastStatus = {
  sending: 'sending',
  sent: 'sent',
} as const;

export interface AdminBroadcast {
  id: string;
  title: string;
  body: string;
  audience: AdminBroadcastAudience;
  /** @nullable */
  chat: AdminBroadcastChat;
  status: AdminBroadcastStatus;
  devices: number;
  admin: string;
  createdAt: string;
  /** @nullable */
  finishedAt: string | null;
}

/**
 * @nullable
 */
export type GifSettingsResponseUpdatedBy = {
  id: string;
  name: string;
} | null;

export interface GifSettingsResponse {
  configured: boolean;
  /** @nullable */
  updatedAt: string | null;
  /** @nullable */
  updatedBy: GifSettingsResponseUpdatedBy;
}

export interface GifSettingsBody {
  /**
     * @maxLength 200
     * @pattern ^[A-Za-z0-9]*$
     */
  apiKey: string;
}

export type AdminListPhonesParams = {
/**
 * @maxLength 32
 */
search?: string;
/**
 * @maxLength 40
 */
cursor?: string;
};

export type AdminListDeletionRequestsParams = {
status?: AdminListDeletionRequestsStatus;
};

export type AdminListDeletionRequestsStatus = typeof AdminListDeletionRequestsStatus[keyof typeof AdminListDeletionRequestsStatus];


export const AdminListDeletionRequestsStatus = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
} as const;

export type SearchUsersParams = {
/**
 * @minLength 3
 * @maxLength 64
 */
q: string;
};

export type ListMessagesParams = {
/**
 * @exclusiveMinimum 0
 */
before?: number;
/**
 * @minimum 0
 * @nullable
 */
after?: number | null;
/**
 * @minimum 1
 * @maximum 50
 */
limit?: number;
};

export type SearchChatParams = {
/**
 * @minLength 1
 * @maxLength 100
 */
q: string;
/**
 * @exclusiveMinimum 0
 */
before?: number;
};

export type SyncParams = {
/**
 * @minimum 0
 * @nullable
 */
since?: number | null;
};

export type GetMessageFileParams = {
download?: GetMessageFileDownload;
};

export type GetMessageFileDownload = typeof GetMessageFileDownload[keyof typeof GetMessageFileDownload];


export const GetMessageFileDownload = {
  true: 'true',
  false: 'false',
} as const;

export type ListChatMediaParams = {
kind: ListChatMediaKind;
/**
 * @exclusiveMinimum 0
 */
before?: number;
};

export type ListChatMediaKind = typeof ListChatMediaKind[keyof typeof ListChatMediaKind];


export const ListChatMediaKind = {
  media: 'media',
  files: 'files',
  voice: 'voice',
} as const;

export type SearchGifsParams = {
/**
 * @maxLength 50
 */
q?: string;
/**
 * @minimum 0
 * @maximum 4999
 * @nullable
 */
offset?: number | null;
};

export type GetGifPreviewParams = {
/**
 * @minLength 1
 * @maxLength 1000
 */
u: string;
/**
 * @exclusiveMinimum 0
 */
e: number;
/**
 * @pattern ^[A-Za-z0-9_-]{43}$
 */
s: string;
};

export type ListGroupMembersParams = {
after?: string;
};

export type AdminUserPermissionsParams = {
/**
 * @minLength 5
 * @maxLength 32
 */
phone: string;
};

export type SearchChannelsParams = {
/**
 * @minLength 2
 * @maxLength 64
 */
q: string;
};

export type SearchEverywhereParams = {
/**
 * @maxLength 100
 */
q?: string;
kind?: SearchEverywhereKind;
chatId?: string;
fromUserId?: string;
after?: string;
before?: string;
cursor?: string;
};

export type SearchEverywhereKind = typeof SearchEverywhereKind[keyof typeof SearchEverywhereKind];


export const SearchEverywhereKind = {
  messages: 'messages',
  media: 'media',
  files: 'files',
  voice: 'voice',
} as const;

export type AdminListUsersParams = {
/**
 * @maxLength 64
 */
q?: string;
status?: AdminListUsersStatus;
/**
 * @maxLength 200
 */
cursor?: string;
};

export type AdminListUsersStatus = typeof AdminListUsersStatus[keyof typeof AdminListUsersStatus];


export const AdminListUsersStatus = {
  active: 'active',
  suspended: 'suspended',
  banned: 'banned',
  deletion_requested: 'deletion_requested',
  deleted: 'deleted',
} as const;

export type AdminListChatsParams = {
type?: AdminListChatsType;
/**
 * @maxLength 64
 */
q?: string;
/**
 * @maxLength 200
 */
cursor?: string;
};

export type AdminListChatsType = typeof AdminListChatsType[keyof typeof AdminListChatsType];


export const AdminListChatsType = {
  group: 'group',
  channel: 'channel',
} as const;

export type AdminListChatMembersParams = {
after?: string;
};

export type AdminListReportsParams = {
status?: AdminListReportsStatus;
/**
 * @maxLength 200
 */
cursor?: string;
};

export type AdminListReportsStatus = typeof AdminListReportsStatus[keyof typeof AdminListReportsStatus];


export const AdminListReportsStatus = {
  open: 'open',
  decided: 'decided',
} as const;

export type AdminAuditHistoryParams = {
kind: AdminAuditHistoryKind;
userId?: string;
chatId?: string;
/**
 * @minLength 3
 * @maxLength 500
 */
reason: string;
/**
 * @maxLength 200
 */
cursor?: string;
};

export type AdminAuditHistoryKind = typeof AdminAuditHistoryKind[keyof typeof AdminAuditHistoryKind];


export const AdminAuditHistoryKind = {
  messages: 'messages',
  identity: 'identity',
  membership: 'membership',
  account: 'account',
  security: 'security',
  screenshots: 'screenshots',
  admin: 'admin',
} as const;

export const getGetHealthLiveUrl = () => {




  return `/health/live`
}

/**
 * @summary Process liveness
 */
export const getHealthLive = async ( options?: Parameters<typeof apiFetch>[1]): Promise<LiveResponse> => {

  return apiFetch<LiveResponse>(getGetHealthLiveUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getGetHealthReadyUrl = () => {




  return `/health/ready`
}

/**
 * @summary Readiness of the API and its dependencies
 */
export const getHealthReady = async ( options?: Parameters<typeof apiFetch>[1]): Promise<ReadyResponse> => {

  return apiFetch<ReadyResponse>(getGetHealthReadyUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getRequestSignInCodeUrl = () => {




  return `/v1/auth/otp/request`
}

/**
 * @summary Send a sign-in code by WhatsApp (same answer for every number)
 */
export const requestSignInCode = async (otpRequestBody: OtpRequestBody, options?: Parameters<typeof apiFetch>[1]): Promise<OtpRequestResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OtpRequestResponse>(getRequestSignInCodeUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(otpRequestBody)
  }
);}



export const getVerifySignInCodeUrl = () => {




  return `/v1/auth/otp/verify`
}

/**
 * @summary Verify the code; signs in or asks for the 2-Step password
 */
export const verifySignInCode = async (otpVerifyBody: OtpVerifyBody, options?: Parameters<typeof apiFetch>[1]): Promise<OtpVerifyResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OtpVerifyResponse>(getVerifySignInCodeUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(otpVerifyBody)
  }
);}



export const getVerifyTwoStepUrl = () => {




  return `/v1/auth/two-step/verify`
}

/**
 * @summary Complete sign-in with the 2-Step Verification password
 */
export const verifyTwoStep = async (twoStepVerifyBody: TwoStepVerifyBody, options?: Parameters<typeof apiFetch>[1]): Promise<AuthenticatedResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AuthenticatedResponse>(getVerifyTwoStepUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(twoStepVerifyBody)
  }
);}



export const getRefreshSessionUrl = () => {




  return `/v1/auth/refresh`
}

/**
 * @summary Rotate the refresh token and get a new access token
 */
export const refreshSession = async ( options?: Parameters<typeof apiFetch>[1]): Promise<AuthenticatedResponse> => {

  return apiFetch<AuthenticatedResponse>(getRefreshSessionUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getLogoutUrl = () => {




  return `/v1/auth/logout`
}

/**
 * @summary End this session
 */
export const logout = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getLogoutUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getGetMeUrl = () => {




  return `/v1/me`
}

/**
 * @summary Current account
 */
export const getMe = async ( options?: Parameters<typeof apiFetch>[1]): Promise<Me> => {

  return apiFetch<Me>(getGetMeUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getUpdateMeUrl = () => {




  return `/v1/me`
}

/**
 * @summary Change name, username or bio
 */
export const updateMe = async (updateMeBody: UpdateMeBody, options?: Parameters<typeof apiFetch>[1]): Promise<Me> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Me>(getUpdateMeUrl(),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateMeBody)
  }
);}



export const getGetPrivacyUrl = () => {




  return `/v1/me/privacy`
}

/**
 * @summary Privacy settings
 */
export const getPrivacy = async ( options?: Parameters<typeof apiFetch>[1]): Promise<Privacy> => {

  return apiFetch<Privacy>(getGetPrivacyUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getUpdatePrivacyUrl = () => {




  return `/v1/me/privacy`
}

/**
 * @summary Change privacy settings
 */
export const updatePrivacy = async (updatePrivacyBody: UpdatePrivacyBody, options?: Parameters<typeof apiFetch>[1]): Promise<Privacy> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Privacy>(getUpdatePrivacyUrl(),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updatePrivacyBody)
  }
);}



export const getStartPhotoUploadUrl = () => {




  return `/v1/me/photo/upload`
}

/**
 * @summary One-time signed upload URL for a new profile picture
 */
export const startPhotoUpload = async (photoUploadBody: PhotoUploadBody, options?: Parameters<typeof apiFetch>[1]): Promise<PhotoUploadResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<PhotoUploadResponse>(getStartPhotoUploadUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(photoUploadBody)
  }
);}



export const getConfirmPhotoUploadUrl = () => {




  return `/v1/me/photo/confirm`
}

/**
 * @summary Check the uploaded picture and make it the profile picture
 */
export const confirmPhotoUpload = async (photoConfirmBody: PhotoConfirmBody, options?: Parameters<typeof apiFetch>[1]): Promise<Me> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Me>(getConfirmPhotoUploadUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(photoConfirmBody)
  }
);}



export const getRemovePhotoUrl = () => {




  return `/v1/me/photo`
}

/**
 * @summary Remove the profile picture
 */
export const removePhoto = async ( options?: Parameters<typeof apiFetch>[1]): Promise<Me> => {

  return apiFetch<Me>(getRemovePhotoUrl(),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getRequestPhoneChangeUrl = () => {




  return `/v1/me/phone/request`
}

/**
 * @summary Send a code to the new phone number
 */
export const requestPhoneChange = async (phoneChangeRequestBody: PhoneChangeRequestBody, options?: Parameters<typeof apiFetch>[1]): Promise<OtpRequestResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OtpRequestResponse>(getRequestPhoneChangeUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(phoneChangeRequestBody)
  }
);}



export const getVerifyPhoneChangeUrl = () => {




  return `/v1/me/phone/verify`
}

/**
 * @summary Confirm the new phone number
 */
export const verifyPhoneChange = async (phoneChangeVerifyBody: PhoneChangeVerifyBody, options?: Parameters<typeof apiFetch>[1]): Promise<Me> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Me>(getVerifyPhoneChangeUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(phoneChangeVerifyBody)
  }
);}



export const getListSessionsUrl = () => {




  return `/v1/me/sessions`
}

/**
 * @summary Signed-in devices
 */
export const listSessions = async ( options?: Parameters<typeof apiFetch>[1]): Promise<SessionsResponse> => {

  return apiFetch<SessionsResponse>(getListSessionsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getTerminateOtherSessionsUrl = () => {




  return `/v1/me/sessions/terminate-others`
}

/**
 * @summary Sign out every other device
 */
export const terminateOtherSessions = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getTerminateOtherSessionsUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getTerminateSessionUrl = (id: string,) => {




  return `/v1/me/sessions/${id}`
}

/**
 * @summary Sign out one device
 */
export const terminateSession = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getTerminateSessionUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getGetTwoStepUrl = () => {




  return `/v1/me/two-step`
}

/**
 * @summary 2-Step Verification status
 */
export const getTwoStep = async ( options?: Parameters<typeof apiFetch>[1]): Promise<TwoStepStatus> => {

  return apiFetch<TwoStepStatus>(getGetTwoStepUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getSetTwoStepUrl = () => {




  return `/v1/me/two-step`
}

/**
 * @summary Turn on or change the 2-Step password
 */
export const setTwoStep = async (twoStepSetBody: TwoStepSetBody, options?: Parameters<typeof apiFetch>[1]): Promise<TwoStepStatus> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<TwoStepStatus>(getSetTwoStepUrl(),
  {
    ...options,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(twoStepSetBody)
  }
);}



export const getDisableTwoStepUrl = () => {




  return `/v1/me/two-step/disable`
}

/**
 * @summary Turn off 2-Step Verification
 */
export const disableTwoStep = async (twoStepDisableBody: TwoStepDisableBody, options?: Parameters<typeof apiFetch>[1]): Promise<TwoStepStatus> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<TwoStepStatus>(getDisableTwoStepUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(twoStepDisableBody)
  }
);}



export const getListSecurityNoticesUrl = () => {




  return `/v1/me/security-notices`
}

/**
 * @summary Login alerts and account notices
 */
export const listSecurityNotices = async ( options?: Parameters<typeof apiFetch>[1]): Promise<SecurityNoticesResponse> => {

  return apiFetch<SecurityNoticesResponse>(getListSecurityNoticesUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getMarkSecurityNoticesReadUrl = () => {




  return `/v1/me/security-notices/read`
}

/**
 * @summary Mark notices as read
 */
export const markSecurityNoticesRead = async (markNoticesReadBody: MarkNoticesReadBody, options?: Parameters<typeof apiFetch>[1]): Promise<SecurityNoticesResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<SecurityNoticesResponse>(getMarkSecurityNoticesReadUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(markNoticesReadBody)
  }
);}



export const getGetPushConfigUrl = () => {




  return `/v1/push/config`
}

/**
 * @summary Web Push public key
 */
export const getPushConfig = async ( options?: Parameters<typeof apiFetch>[1]): Promise<PushConfigResponse> => {

  return apiFetch<PushConfigResponse>(getGetPushConfigUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getSavePushSubscriptionUrl = () => {




  return `/v1/me/push-subscription`
}

/**
 * @summary Register this browser for push notifications
 */
export const savePushSubscription = async (pushSubscriptionBody: PushSubscriptionBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getSavePushSubscriptionUrl(),
  {
    ...options,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(pushSubscriptionBody)
  }
);}



export const getRemovePushSubscriptionUrl = () => {




  return `/v1/me/push-subscription`
}

/**
 * @summary Stop push notifications on this browser
 */
export const removePushSubscription = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getRemovePushSubscriptionUrl(),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getRequestAccountDeletionUrl = () => {




  return `/v1/me/deletion-request`
}

/**
 * @summary Ask an administrator to delete this account
 */
export const requestAccountDeletion = async ( options?: Parameters<typeof apiFetch>[1]): Promise<DeletionRequestResponse> => {

  return apiFetch<DeletionRequestResponse>(getRequestAccountDeletionUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getAdminPasswordLoginUrl = () => {




  return `/v1/admin/auth/password/login`
}

/**
 * @summary Admin sign-in step 1: phone and password (D-34); the authenticator code follows
 */
export const adminPasswordLogin = async (adminPasswordLoginBody: AdminPasswordLoginBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminPasswordLoginResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminPasswordLoginResponse>(getAdminPasswordLoginUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminPasswordLoginBody)
  }
);}



export const getAdminPasswordSetupUrl = () => {




  return `/v1/admin/auth/password/setup`
}

/**
 * @summary Set an admin password with an owner-issued setup token (D-34); signs nobody in
 */
export const adminPasswordSetup = async (adminPasswordSetupBody: AdminPasswordSetupBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getAdminPasswordSetupUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminPasswordSetupBody)
  }
);}



export const getAdminVerifyTotpUrl = () => {




  return `/v1/admin/auth/totp/verify`
}

/**
 * @summary Verify the authenticator-app code and start the admin session
 */
export const adminVerifyTotp = async (adminTotpVerifyBody: AdminTotpVerifyBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminSessionResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminSessionResponse>(getAdminVerifyTotpUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminTotpVerifyBody)
  }
);}



export const getAdminSetupTotpUrl = () => {




  return `/v1/admin/auth/totp/setup`
}

/**
 * @summary First sign-in of an account created by SQL: generate the authenticator secret (Phase 3.1)
 */
export const adminSetupTotp = async (adminTotpSetupBody: AdminTotpSetupBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminTotpSetupResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminTotpSetupResponse>(getAdminSetupTotpUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminTotpSetupBody)
  }
);}



export const getAdminBootstrapStatusUrl = () => {




  return `/v1/admin/bootstrap`
}

/**
 * @summary Whether the one-time initial setup is open
 */
export const adminBootstrapStatus = async ( options?: Parameters<typeof apiFetch>[1]): Promise<AdminBootstrapStatusResponse> => {

  return apiFetch<AdminBootstrapStatusResponse>(getAdminBootstrapStatusUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminBootstrapSetWaabekKeyUrl = () => {




  return `/v1/admin/bootstrap/waabek-key`
}

/**
 * @summary Initial setup: store the first Waabek API key (setup token required)
 */
export const adminBootstrapSetWaabekKey = async (adminBootstrapWaabekKeyBody: AdminBootstrapWaabekKeyBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getAdminBootstrapSetWaabekKeyUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminBootstrapWaabekKeyBody)
  }
);}



export const getAdminBootstrapTestMessageUrl = () => {




  return `/v1/admin/bootstrap/test-message`
}

/**
 * @summary Initial setup: send a WhatsApp test message to the Super Admin (setup token required)
 */
export const adminBootstrapTestMessage = async (adminBootstrapTestBody: AdminBootstrapTestBody, options?: Parameters<typeof apiFetch>[1]): Promise<WaabekTestResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<WaabekTestResponse>(getAdminBootstrapTestMessageUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminBootstrapTestBody)
  }
);}



export const getAdminOtpRecoveryStatusUrl = () => {




  return `/v1/admin/otp-recovery`
}

/**
 * @summary Whether an owner-opened Waabek key recovery is open
 */
export const adminOtpRecoveryStatus = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OtpRecoveryStatusResponse> => {

  return apiFetch<OtpRecoveryStatusResponse>(getAdminOtpRecoveryStatusUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminOtpRecoverySetWaabekKeyUrl = () => {




  return `/v1/admin/otp-recovery/waabek-key`
}

/**
 * @summary Recovery: store a new Waabek API key (recovery token required; signs nobody in)
 */
export const adminOtpRecoverySetWaabekKey = async (otpRecoveryWaabekKeyBody: OtpRecoveryWaabekKeyBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getAdminOtpRecoverySetWaabekKeyUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(otpRecoveryWaabekKeyBody)
  }
);}



export const getAdminOtpRecoveryTestMessageUrl = () => {




  return `/v1/admin/otp-recovery/test-message`
}

/**
 * @summary Recovery: send a WhatsApp test message to the first Super Admin (recovery token required)
 */
export const adminOtpRecoveryTestMessage = async (otpRecoveryTestBody: OtpRecoveryTestBody, options?: Parameters<typeof apiFetch>[1]): Promise<WaabekTestResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<WaabekTestResponse>(getAdminOtpRecoveryTestMessageUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(otpRecoveryTestBody)
  }
);}



export const getAdminSessionUrl = () => {




  return `/v1/admin/session`
}

/**
 * @summary Current admin
 */
export const adminSession = async ( options?: Parameters<typeof apiFetch>[1]): Promise<AdminSessionResponse> => {

  return apiFetch<AdminSessionResponse>(getAdminSessionUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminLogoutUrl = () => {




  return `/v1/admin/session/logout`
}

/**
 * @summary End the admin session
 */
export const adminLogout = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getAdminLogoutUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getAdminChangePasswordUrl = () => {




  return `/v1/admin/account/password`
}

/**
 * @summary Change one's own password with the current password and an authenticator code (D-34); ends the other sessions
 */
export const adminChangePassword = async (adminPasswordChangeBody: AdminPasswordChangeBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminPasswordChangeResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminPasswordChangeResponse>(getAdminChangePasswordUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminPasswordChangeBody)
  }
);}



export const getAdminListPhonesUrl = (params?: AdminListPhonesParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/phone-list?${stringifiedParams}` : `/v1/admin/phone-list`
}

/**
 * @summary Academy phone list
 */
export const adminListPhones = async (params?: AdminListPhonesParams, options?: Parameters<typeof apiFetch>[1]): Promise<PhoneListResponse> => {

  return apiFetch<PhoneListResponse>(getAdminListPhonesUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminAddPhoneUrl = () => {




  return `/v1/admin/phone-list`
}

/**
 * @summary Add a number (Super Admin)
 */
export const adminAddPhone = async (phoneListAddBody: PhoneListAddBody, options?: Parameters<typeof apiFetch>[1]): Promise<PhoneListAddResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<PhoneListAddResponse>(getAdminAddPhoneUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(phoneListAddBody)
  }
);}



export const getAdminImportPhonesUrl = () => {




  return `/v1/admin/phone-list/import`
}

/**
 * @summary Import numbers from CSV (Super Admin)
 */
export const adminImportPhones = async (phoneListImportBody: PhoneListImportBody, options?: Parameters<typeof apiFetch>[1]): Promise<PhoneListImportResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<PhoneListImportResponse>(getAdminImportPhonesUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(phoneListImportBody)
  }
);}



export const getAdminListDeletionRequestsUrl = (params?: AdminListDeletionRequestsParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/deletion-requests?${stringifiedParams}` : `/v1/admin/deletion-requests`
}

/**
 * @summary Account deletion requests
 */
export const adminListDeletionRequests = async (params?: AdminListDeletionRequestsParams, options?: Parameters<typeof apiFetch>[1]): Promise<DeletionRequestListResponse> => {

  return apiFetch<DeletionRequestListResponse>(getAdminListDeletionRequestsUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminDeletionRequestUrl = (id: string,) => {




  return `/v1/admin/deletion-requests/${id}`
}

/**
 * @summary One request with account activity and history
 */
export const adminDeletionRequest = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<DeletionRequestDetail> => {

  return apiFetch<DeletionRequestDetail>(getAdminDeletionRequestUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminApproveDeletionUrl = (id: string,) => {




  return `/v1/admin/deletion-requests/${id}/approve`
}

/**
 * @summary Approve and delete the account (Super Admin)
 */
export const adminApproveDeletion = async (id: string,
    deletionDecisionBody: DeletionDecisionBody, options?: Parameters<typeof apiFetch>[1]): Promise<DeletionRequestDetail> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<DeletionRequestDetail>(getAdminApproveDeletionUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(deletionDecisionBody)
  }
);}



export const getAdminRejectDeletionUrl = (id: string,) => {




  return `/v1/admin/deletion-requests/${id}/reject`
}

/**
 * @summary Reject the request (Super Admin)
 */
export const adminRejectDeletion = async (id: string,
    deletionDecisionBody: DeletionDecisionBody, options?: Parameters<typeof apiFetch>[1]): Promise<DeletionRequestDetail> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<DeletionRequestDetail>(getAdminRejectDeletionUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(deletionDecisionBody)
  }
);}



export const getAdminResetTwoStepUrl = () => {




  return `/v1/admin/users/two-step-reset`
}

/**
 * @summary Reset a user's 2-Step password after an identity check (Super Admin)
 */
export const adminResetTwoStep = async (twoStepResetBody: TwoStepResetBody, options?: Parameters<typeof apiFetch>[1]): Promise<TwoStepResetResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<TwoStepResetResponse>(getAdminResetTwoStepUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(twoStepResetBody)
  }
);}



export const getAdminOtpSettingsUrl = () => {




  return `/v1/admin/settings/otp`
}

/**
 * @summary OTP delivery settings; the Waabek API key is never returned (Super Admin)
 */
export const adminOtpSettings = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OtpSettingsResponse> => {

  return apiFetch<OtpSettingsResponse>(getAdminOtpSettingsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminReplaceWaabekKeyUrl = () => {




  return `/v1/admin/settings/otp/waabek-key`
}

/**
 * @summary Replace the Waabek API key; needs a current authenticator code (Super Admin)
 */
export const adminReplaceWaabekKey = async (otpSettingsReplaceKeyBody: OtpSettingsReplaceKeyBody, options?: Parameters<typeof apiFetch>[1]): Promise<OtpSettingsReplaceKeyResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OtpSettingsReplaceKeyResponse>(getAdminReplaceWaabekKeyUrl(),
  {
    ...options,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(otpSettingsReplaceKeyBody)
  }
);}



export const getAdminSendWaabekTestUrl = () => {




  return `/v1/admin/settings/otp/test-message`
}

/**
 * @summary Send a WhatsApp test message to your own number (Super Admin)
 */
export const adminSendWaabekTest = async ( options?: Parameters<typeof apiFetch>[1]): Promise<WaabekTestResponse> => {

  return apiFetch<WaabekTestResponse>(getAdminSendWaabekTestUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getSearchUsersUrl = (params: SearchUsersParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/users/search?${stringifiedParams}` : `/v1/users/search`
}

/**
 * @summary Find a user to message by name or username (P-25)
 */
export const searchUsers = async (params: SearchUsersParams, options?: Parameters<typeof apiFetch>[1]): Promise<UserSearchResponse> => {

  return apiFetch<UserSearchResponse>(getSearchUsersUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getGetUserUrl = (id: string,) => {




  return `/v1/users/${id}`
}

/**
 * @summary Another user as the signed-in user may see them
 */
export const getUser = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Peer> => {

  return apiFetch<Peer>(getGetUserUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getBlockUserUrl = (id: string,) => {




  return `/v1/users/${id}/block`
}

/**
 * @summary Block a user (P-26, P-30)
 */
export const blockUser = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getBlockUserUrl(id),
  {
    ...options,
    method: 'POST'


  }
);}



export const getUnblockUserUrl = (id: string,) => {




  return `/v1/users/${id}/block`
}

/**
 * @summary Unblock a user
 */
export const unblockUser = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getUnblockUserUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getListChatsUrl = () => {




  return `/v1/chats`
}

/**
 * @summary Chat list with unread counts and chat-list state
 */
export const listChats = async ( options?: Parameters<typeof apiFetch>[1]): Promise<ChatsResponse> => {

  return apiFetch<ChatsResponse>(getListChatsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getOpenChatUrl = () => {




  return `/v1/chats`
}

/**
 * @summary Open the private chat with a user (existing or new)
 */
export const openChat = async (createChatBody: CreateChatBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getOpenChatUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(createChatBody)
  }
);}



export const getGetChatUrl = (id: string,) => {




  return `/v1/chats/${id}`
}

/**
 * @summary One chat
 */
export const getChat = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

  return apiFetch<Chat>(getGetChatUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getListMessagesUrl = (id: string,
    params?: ListMessagesParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/chats/${id}/messages?${stringifiedParams}` : `/v1/chats/${id}/messages`
}

/**
 * @summary Chat history in pages of up to 50 (P-17)
 */
export const listMessages = async (id: string,
    params?: ListMessagesParams, options?: Parameters<typeof apiFetch>[1]): Promise<MessagesResponse> => {

  return apiFetch<MessagesResponse>(getListMessagesUrl(id,params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getSendMessageUrl = (id: string,) => {




  return `/v1/chats/${id}/messages`
}

/**
 * @summary Send a message (idempotent by client id)
 */
export const sendMessage = async (id: string,
    sendMessageBody: SendMessageBody, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Message>(getSendMessageUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(sendMessageBody)
  }
);}



export const getSearchChatUrl = (id: string,
    params: SearchChatParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/chats/${id}/search?${stringifiedParams}` : `/v1/chats/${id}/search`
}

/**
 * @summary Search messages in one chat
 */
export const searchChat = async (id: string,
    params: SearchChatParams, options?: Parameters<typeof apiFetch>[1]): Promise<MessagesResponse> => {

  return apiFetch<MessagesResponse>(getSearchChatUrl(id,params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getListPinnedMessagesUrl = (id: string,) => {




  return `/v1/chats/${id}/pins`
}

/**
 * @summary Pinned messages (P-22)
 */
export const listPinnedMessages = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<MessagesResponse> => {

  return apiFetch<MessagesResponse>(getListPinnedMessagesUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getMarkChatReadUrl = (id: string,) => {




  return `/v1/chats/${id}/read`
}

/**
 * @summary Mark as read up to a message (P-20)
 */
export const markChatRead = async (id: string,
    readChatBody: ReadChatBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getMarkChatReadUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(readChatBody)
  }
);}



export const getMarkChatDeliveredUrl = (id: string,) => {




  return `/v1/chats/${id}/delivered`
}

/**
 * @summary This device received the messages up to a seq
 */
export const markChatDelivered = async (id: string,
    readChatBody: ReadChatBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getMarkChatDeliveredUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(readChatBody)
  }
);}



export const getUpdateChatStateUrl = (id: string,) => {




  return `/v1/chats/${id}/state`
}

/**
 * @summary Pin, archive or mark as unread (P-19, P-20)
 */
export const updateChatState = async (id: string,
    chatStateBody: ChatStateBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getUpdateChatStateUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(chatStateBody)
  }
);}



export const getEditMessageUrl = (id: string,) => {




  return `/v1/messages/${id}`
}

/**
 * @summary Edit one's own message (O-27)
 */
export const editMessage = async (id: string,
    editMessageBody: EditMessageBody, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Message>(getEditMessageUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(editMessageBody)
  }
);}



export const getDeleteMessagesUrl = () => {




  return `/v1/messages/delete`
}

/**
 * @summary Delete for me or for both sides (P-29)
 */
export const deleteMessages = async (deleteMessagesBody: DeleteMessagesBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getDeleteMessagesUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(deleteMessagesBody)
  }
);}



export const getForwardMessagesUrl = () => {




  return `/v1/messages/forward`
}

/**
 * @summary Forward up to 100 messages to up to 10 chats (P-23)
 */
export const forwardMessages = async (forwardMessagesBody: ForwardMessagesBody, options?: Parameters<typeof apiFetch>[1]): Promise<MessagesResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<MessagesResponse>(getForwardMessagesUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(forwardMessagesBody)
  }
);}



export const getPinMessageUrl = (id: string,) => {




  return `/v1/messages/${id}/pin`
}

/**
 * @summary Pin a message for both participants (P-22)
 */
export const pinMessage = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

  return apiFetch<Message>(getPinMessageUrl(id),
  {
    ...options,
    method: 'PUT'


  }
);}



export const getUnpinMessageUrl = (id: string,) => {




  return `/v1/messages/${id}/pin`
}

/**
 * @summary Unpin a message
 */
export const unpinMessage = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

  return apiFetch<Message>(getUnpinMessageUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getListFoldersUrl = () => {




  return `/v1/folders`
}

/**
 * @summary Chat folders (P-21)
 */
export const listFolders = async ( options?: Parameters<typeof apiFetch>[1]): Promise<FoldersResponse> => {

  return apiFetch<FoldersResponse>(getListFoldersUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getCreateFolderUrl = () => {




  return `/v1/folders`
}

/**
 * @summary Create a folder
 */
export const createFolder = async (createFolderBody: CreateFolderBody, options?: Parameters<typeof apiFetch>[1]): Promise<FoldersResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<FoldersResponse>(getCreateFolderUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(createFolderBody)
  }
);}



export const getUpdateFolderUrl = (id: string,) => {




  return `/v1/folders/${id}`
}

/**
 * @summary Rename a folder or change its chats
 */
export const updateFolder = async (id: string,
    updateFolderBody: UpdateFolderBody, options?: Parameters<typeof apiFetch>[1]): Promise<FoldersResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<FoldersResponse>(getUpdateFolderUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateFolderBody)
  }
);}



export const getDeleteFolderUrl = (id: string,) => {




  return `/v1/folders/${id}`
}

/**
 * @summary Delete a folder (its chats stay)
 */
export const deleteFolder = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<FoldersResponse> => {

  return apiFetch<FoldersResponse>(getDeleteFolderUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getReportUserUrl = () => {




  return `/v1/reports`
}

/**
 * @summary Report a user or a message (P-27)
 */
export const reportUser = async (reportBody: ReportBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getReportUserUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(reportBody)
  }
);}



export const getRecordScreenshotUrl = () => {




  return `/v1/screenshot-events`
}

/**
 * @summary Screenshot event from the iOS or Android app (P-28)
 */
export const recordScreenshot = async (screenshotEventBody: ScreenshotEventBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getRecordScreenshotUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(screenshotEventBody)
  }
);}



export const getSyncUrl = (params?: SyncParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/sync?${stringifiedParams}` : `/v1/sync`
}

/**
 * @summary Updates since a seq (P-17)
 */
export const sync = async (params?: SyncParams, options?: Parameters<typeof apiFetch>[1]): Promise<SyncResponse> => {

  return apiFetch<SyncResponse>(getSyncUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getGetRealtimeChannelUrl = () => {




  return `/v1/realtime/channel`
}

/**
 * @summary This device's private realtime channel (signals only, no content)
 */
export const getRealtimeChannel = async ( options?: Parameters<typeof apiFetch>[1]): Promise<RealtimeChannelResponse> => {

  return apiFetch<RealtimeChannelResponse>(getGetRealtimeChannelUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getRealtimeHeartbeatUrl = () => {




  return `/v1/realtime/heartbeat`
}

/**
 * @summary Online for the next 60 seconds (every 25 s, P-18); returns the current update seq
 */
export const realtimeHeartbeat = async ( options?: Parameters<typeof apiFetch>[1]): Promise<RealtimeHeartbeatResponse> => {

  return apiFetch<RealtimeHeartbeatResponse>(getRealtimeHeartbeatUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getRealtimeTypingUrl = () => {




  return `/v1/realtime/typing`
}

/**
 * @summary The user is typing in a chat (shown for 6 seconds, P-18)
 */
export const realtimeTyping = async (realtimeTypingBody: RealtimeTypingBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getRealtimeTypingUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(realtimeTypingBody)
  }
);}



export const getRealtimeOfflineUrl = () => {




  return `/v1/realtime/offline`
}

/**
 * @summary This device is going away (no longer online)
 */
export const realtimeOffline = async ( options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getRealtimeOfflineUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getCreateUploadUrl = () => {




  return `/v1/files/uploads`
}

/**
 * @summary One-time signed upload URLs for a file to send in a chat
 */
export const createUpload = async (uploadRequestBody: UploadRequestBody, options?: Parameters<typeof apiFetch>[1]): Promise<UploadResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<UploadResponse>(getCreateUploadUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(uploadRequestBody)
  }
);}



export const getGetMessageFileUrl = (id: string,
    params?: GetMessageFileParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/messages/${id}/file?${stringifiedParams}` : `/v1/messages/${id}/file`
}

/**
 * @summary A signed link (5 minutes) to a message's file
 */
export const getMessageFile = async (id: string,
    params?: GetMessageFileParams, options?: Parameters<typeof apiFetch>[1]): Promise<FileUrlResponse> => {

  return apiFetch<FileUrlResponse>(getGetMessageFileUrl(id,params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getReactToMessageUrl = (id: string,) => {




  return `/v1/messages/${id}/reaction`
}

/**
 * @summary React to a message (one reaction per person)
 */
export const reactToMessage = async (id: string,
    reactionBody: ReactionBody, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Message>(getReactToMessageUrl(id),
  {
    ...options,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(reactionBody)
  }
);}



export const getRemoveReactionUrl = (id: string,) => {




  return `/v1/messages/${id}/reaction`
}

/**
 * @summary Take back one's reaction
 */
export const removeReaction = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

  return apiFetch<Message>(getRemoveReactionUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getListChatMediaUrl = (id: string,
    params: ListChatMediaParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/chats/${id}/media?${stringifiedParams}` : `/v1/chats/${id}/media`
}

/**
 * @summary A chat's photos and videos, files or voice messages
 */
export const listChatMedia = async (id: string,
    params: ListChatMediaParams, options?: Parameters<typeof apiFetch>[1]): Promise<MessagesResponse> => {

  return apiFetch<MessagesResponse>(getListChatMediaUrl(id,params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getListStickersUrl = () => {




  return `/v1/stickers`
}

/**
 * @summary Sticker packs (O-10)
 */
export const listStickers = async ( options?: Parameters<typeof apiFetch>[1]): Promise<StickerPacksResponse> => {

  return apiFetch<StickerPacksResponse>(getListStickersUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getSearchGifsUrl = (params?: SearchGifsParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/gifs/search?${stringifiedParams}` : `/v1/gifs/search`
}

/**
 * @summary Search GIFs, or trending GIFs without a query (O-09)
 */
export const searchGifs = async (params?: SearchGifsParams, options?: Parameters<typeof apiFetch>[1]): Promise<GifSearchResponse> => {

  return apiFetch<GifSearchResponse>(getSearchGifsUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getGetGifPreviewUrl = (params: GetGifPreviewParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/gifs/preview?${stringifiedParams}` : `/v1/gifs/preview`
}

/**
 * @summary A GIF preview image (signed link from GIF search)
 */
export const getGifPreview = async (params: GetGifPreviewParams, options?: Parameters<typeof apiFetch>[1]): Promise<Blob> => {

  return apiFetch<Blob>(getGetGifPreviewUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminListStickersUrl = () => {




  return `/v1/admin/stickers`
}

/**
 * @summary Sticker packs with removed stickers
 */
export const adminListStickers = async ( options?: Parameters<typeof apiFetch>[1]): Promise<AdminStickerPacksResponse> => {

  return apiFetch<AdminStickerPacksResponse>(getAdminListStickersUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminStickerImageUrl = (id: string,) => {




  return `/v1/admin/stickers/${id}/image`
}

/**
 * @summary A sticker image as base64 (the dashboard shows pictures only from itself)
 */
export const adminStickerImage = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<AdminStickerImageResponse> => {

  return apiFetch<AdminStickerImageResponse>(getAdminStickerImageUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminCreateStickerPackUrl = () => {




  return `/v1/admin/stickers/packs`
}

/**
 * @summary Create a sticker pack (Super Admin)
 */
export const adminCreateStickerPack = async (createStickerPackBody: CreateStickerPackBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminStickerPacksResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminStickerPacksResponse>(getAdminCreateStickerPackUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(createStickerPackBody)
  }
);}



export const getAdminUpdateStickerPackUrl = (id: string,) => {




  return `/v1/admin/stickers/packs/${id}`
}

/**
 * @summary Rename or archive a sticker pack (Super Admin)
 */
export const adminUpdateStickerPack = async (id: string,
    updateStickerPackBody: UpdateStickerPackBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminStickerPacksResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminStickerPacksResponse>(getAdminUpdateStickerPackUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateStickerPackBody)
  }
);}



export const getAdminAddStickerUrl = (id: string,) => {




  return `/v1/admin/stickers/packs/${id}/stickers`
}

/**
 * @summary Add a sticker: PNG or WebP, at most 512 KB and 512 x 512 (Super Admin)
 */
export const adminAddSticker = async (id: string,
    addStickerBody: AddStickerBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminStickerPacksResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminStickerPacksResponse>(getAdminAddStickerUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(addStickerBody)
  }
);}



export const getAdminRemoveStickerUrl = (id: string,) => {




  return `/v1/admin/stickers/${id}`
}

/**
 * @summary Take a sticker out of its pack; messages keep showing it (Super Admin)
 */
export const adminRemoveSticker = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<AdminStickerPacksResponse> => {

  return apiFetch<AdminStickerPacksResponse>(getAdminRemoveStickerUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getCreateGroupUrl = () => {




  return `/v1/groups`
}

/**
 * @summary Create a group (system permission O-21; 10 per day)
 */
export const createGroup = async (createGroupBody: CreateGroupBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getCreateGroupUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(createGroupBody)
  }
);}



export const getUpdateGroupUrl = (id: string,) => {




  return `/v1/groups/${id}`
}

/**
 * @summary Change the title or description
 */
export const updateGroup = async (id: string,
    updateGroupBody: UpdateGroupBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getUpdateGroupUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateGroupBody)
  }
);}



export const getDeleteGroupUrl = (id: string,) => {




  return `/v1/groups/${id}`
}

/**
 * @summary Delete the group (owner); its history stays
 */
export const deleteGroup = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getDeleteGroupUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getUpdateGroupSettingsUrl = (id: string,) => {




  return `/v1/groups/${id}/settings`
}

/**
 * @summary Member permissions and member privacy (O-04)
 */
export const updateGroupSettings = async (id: string,
    groupSettingsBody: GroupSettingsBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getUpdateGroupSettingsUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(groupSettingsBody)
  }
);}



export const getStartGroupPhotoUploadUrl = (id: string,) => {




  return `/v1/groups/${id}/photo/upload`
}

/**
 * @summary One-time signed upload URL for the group picture
 */
export const startGroupPhotoUpload = async (id: string,
    photoUploadBody: PhotoUploadBody, options?: Parameters<typeof apiFetch>[1]): Promise<PhotoUploadResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<PhotoUploadResponse>(getStartGroupPhotoUploadUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(photoUploadBody)
  }
);}



export const getConfirmGroupPhotoUrl = (id: string,) => {




  return `/v1/groups/${id}/photo/confirm`
}

/**
 * @summary Check the uploaded picture and make it the group picture
 */
export const confirmGroupPhoto = async (id: string,
    photoConfirmBody: PhotoConfirmBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getConfirmGroupPhotoUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(photoConfirmBody)
  }
);}



export const getRemoveGroupPhotoUrl = (id: string,) => {




  return `/v1/groups/${id}/photo`
}

/**
 * @summary Remove the group picture
 */
export const removeGroupPhoto = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

  return apiFetch<Chat>(getRemoveGroupPhotoUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getListGroupMembersUrl = (id: string,
    params?: ListGroupMembersParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/groups/${id}/members?${stringifiedParams}` : `/v1/groups/${id}/members`
}

/**
 * @summary Members (owner, admins, or when the list is not hidden, §7)
 */
export const listGroupMembers = async (id: string,
    params?: ListGroupMembersParams, options?: Parameters<typeof apiFetch>[1]): Promise<GroupMembersResponse> => {

  return apiFetch<GroupMembersResponse>(getListGroupMembersUrl(id,params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAddGroupMembersUrl = (id: string,) => {




  return `/v1/groups/${id}/members`
}

/**
 * @summary Add members (up to 50 at once, 500 in a group)
 */
export const addGroupMembers = async (id: string,
    addMembersBody: AddMembersBody, options?: Parameters<typeof apiFetch>[1]): Promise<AddMembersResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AddMembersResponse>(getAddGroupMembersUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(addMembersBody)
  }
);}



export const getUpdateGroupMemberUrl = (id: string,
    userId: string,) => {




  return `/v1/groups/${id}/members/${userId}`
}

/**
 * @summary Promote, demote, change admin rights or restrict a member
 */
export const updateGroupMember = async (id: string,
    userId: string,
    updateMemberBody: UpdateMemberBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getUpdateGroupMemberUrl(id,userId),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateMemberBody)
  }
);}



export const getRemoveGroupMemberUrl = (id: string,
    userId: string,) => {




  return `/v1/groups/${id}/members/${userId}`
}

/**
 * @summary Remove a member
 */
export const removeGroupMember = async (id: string,
    userId: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getRemoveGroupMemberUrl(id,userId),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getTransferGroupOwnershipUrl = (id: string,) => {




  return `/v1/groups/${id}/owner`
}

/**
 * @summary Give the group to another member (owner)
 */
export const transferGroupOwnership = async (id: string,
    transferOwnershipBody: TransferOwnershipBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getTransferGroupOwnershipUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(transferOwnershipBody)
  }
);}



export const getLeaveGroupUrl = (id: string,) => {




  return `/v1/groups/${id}/leave`
}

/**
 * @summary Leave the group
 */
export const leaveGroup = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getLeaveGroupUrl(id),
  {
    ...options,
    method: 'POST'


  }
);}



export const getListInviteLinksUrl = (id: string,) => {




  return `/v1/groups/${id}/invites`
}

/**
 * @summary Invite links (admins who may invite)
 */
export const listInviteLinks = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<InviteLinksResponse> => {

  return apiFetch<InviteLinksResponse>(getListInviteLinksUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getCreateInviteLinkUrl = (id: string,) => {




  return `/v1/groups/${id}/invites`
}

/**
 * @summary Create an invite link
 */
export const createInviteLink = async (id: string,
    createInviteLinkBody: CreateInviteLinkBody, options?: Parameters<typeof apiFetch>[1]): Promise<InviteLink> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<InviteLink>(getCreateInviteLinkUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(createInviteLinkBody)
  }
);}



export const getRevokeInviteLinkUrl = (id: string,
    linkId: string,) => {




  return `/v1/groups/${id}/invites/${linkId}`
}

/**
 * @summary Revoke an invite link
 */
export const revokeInviteLink = async (id: string,
    linkId: string, options?: Parameters<typeof apiFetch>[1]): Promise<InviteLinksResponse> => {

  return apiFetch<InviteLinksResponse>(getRevokeInviteLinkUrl(id,linkId),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getListJoinRequestsUrl = (id: string,) => {




  return `/v1/groups/${id}/requests`
}

/**
 * @summary Pending join requests
 */
export const listJoinRequests = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<JoinRequestsResponse> => {

  return apiFetch<JoinRequestsResponse>(getListJoinRequestsUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getApproveJoinRequestUrl = (id: string,
    requestId: string,) => {




  return `/v1/groups/${id}/requests/${requestId}/approve`
}

/**
 * @summary Approve a join request
 */
export const approveJoinRequest = async (id: string,
    requestId: string, options?: Parameters<typeof apiFetch>[1]): Promise<JoinRequestsResponse> => {

  return apiFetch<JoinRequestsResponse>(getApproveJoinRequestUrl(id,requestId),
  {
    ...options,
    method: 'POST'


  }
);}



export const getDeclineJoinRequestUrl = (id: string,
    requestId: string,) => {




  return `/v1/groups/${id}/requests/${requestId}/decline`
}

/**
 * @summary Decline a join request
 */
export const declineJoinRequest = async (id: string,
    requestId: string, options?: Parameters<typeof apiFetch>[1]): Promise<JoinRequestsResponse> => {

  return apiFetch<JoinRequestsResponse>(getDeclineJoinRequestUrl(id,requestId),
  {
    ...options,
    method: 'POST'


  }
);}



export const getPreviewInviteUrl = (code: string,) => {




  return `/v1/invites/${code}`
}

/**
 * @summary What an invite link leads to
 */
export const previewInvite = async (code: string, options?: Parameters<typeof apiFetch>[1]): Promise<InvitePreview> => {

  return apiFetch<InvitePreview>(getPreviewInviteUrl(code),
  {
    ...options,
    method: 'GET'


  }
);}



export const getJoinWithInviteUrl = (code: string,) => {




  return `/v1/invites/${code}/join`
}

/**
 * @summary Join (or ask to join) with an invite link
 */
export const joinWithInvite = async (code: string, options?: Parameters<typeof apiFetch>[1]): Promise<JoinResponse> => {

  return apiFetch<JoinResponse>(getJoinWithInviteUrl(code),
  {
    ...options,
    method: 'POST'


  }
);}



export const getVotePollUrl = (id: string,) => {




  return `/v1/messages/${id}/poll/vote`
}

/**
 * @summary Vote in a poll or answer a quiz
 */
export const votePoll = async (id: string,
    pollVoteBody: PollVoteBody, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Message>(getVotePollUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(pollVoteBody)
  }
);}



export const getRetractPollVoteUrl = (id: string,) => {




  return `/v1/messages/${id}/poll/vote`
}

/**
 * @summary Take a poll vote back (not for quizzes)
 */
export const retractPollVote = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

  return apiFetch<Message>(getRetractPollVoteUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getClosePollUrl = (id: string,) => {




  return `/v1/messages/${id}/poll/close`
}

/**
 * @summary Stop a poll (its creator, or an admin who may delete messages)
 */
export const closePoll = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

  return apiFetch<Message>(getClosePollUrl(id),
  {
    ...options,
    method: 'POST'


  }
);}



export const getListPollVotersUrl = (id: string,) => {




  return `/v1/messages/${id}/poll/voters`
}

/**
 * @summary Who voted (never for anonymous polls; with a hidden member list, admins only)
 */
export const listPollVoters = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<PollVotersResponse> => {

  return apiFetch<PollVotersResponse>(getListPollVotersUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getGetMyPermissionsUrl = () => {




  return `/v1/me/permissions`
}

/**
 * @summary What the signed-in user may create (O-21)
 */
export const getMyPermissions = async ( options?: Parameters<typeof apiFetch>[1]): Promise<UserPermissions> => {

  return apiFetch<UserPermissions>(getGetMyPermissionsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminUserPermissionsUrl = (params: AdminUserPermissionsParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/users/permissions?${stringifiedParams}` : `/v1/admin/users/permissions`
}

/**
 * @summary A user's system permissions (O-21)
 */
export const adminUserPermissions = async (params: AdminUserPermissionsParams, options?: Parameters<typeof apiFetch>[1]): Promise<AdminUserPermissionsResponse> => {

  return apiFetch<AdminUserPermissionsResponse>(getAdminUserPermissionsUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminSetUserPermissionsUrl = () => {




  return `/v1/admin/users/permissions`
}

/**
 * @summary Change a user's system permissions (Super Admin)
 */
export const adminSetUserPermissions = async (adminUserPermissionsBody: AdminUserPermissionsBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminUserPermissionsResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminUserPermissionsResponse>(getAdminSetUserPermissionsUrl(),
  {
    ...options,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminUserPermissionsBody)
  }
);}



export const getCreateChannelUrl = () => {




  return `/v1/channels`
}

/**
 * @summary Create a channel (system permission O-21; 5 per day)
 */
export const createChannel = async (createChannelBody: CreateChannelBody, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<Chat>(getCreateChannelUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(createChannelBody)
  }
);}



export const getSearchChannelsUrl = (params: SearchChannelsParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/channels/search?${stringifiedParams}` : `/v1/channels/search`
}

/**
 * @summary Find public channels by title (O-22)
 */
export const searchChannels = async (params: SearchChannelsParams, options?: Parameters<typeof apiFetch>[1]): Promise<ChannelSearchResponse> => {

  return apiFetch<ChannelSearchResponse>(getSearchChannelsUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getJoinChannelUrl = (id: string,) => {




  return `/v1/channels/${id}/join`
}

/**
 * @summary Subscribe to a public channel
 */
export const joinChannel = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Chat> => {

  return apiFetch<Chat>(getJoinChannelUrl(id),
  {
    ...options,
    method: 'POST'


  }
);}



export const getScheduleMessageUrl = (id: string,) => {




  return `/v1/chats/${id}/scheduled`
}

/**
 * @summary Schedule a message (channel admins who post, or system permission O-21)
 */
export const scheduleMessage = async (id: string,
    scheduleMessageBody: ScheduleMessageBody, options?: Parameters<typeof apiFetch>[1]): Promise<ScheduledMessage> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<ScheduledMessage>(getScheduleMessageUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(scheduleMessageBody)
  }
);}



export const getListScheduledMessagesUrl = (id: string,) => {




  return `/v1/chats/${id}/scheduled`
}

/**
 * @summary The signed-in user's scheduled messages in a chat
 */
export const listScheduledMessages = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<ScheduledMessagesResponse> => {

  return apiFetch<ScheduledMessagesResponse>(getListScheduledMessagesUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getUpdateScheduledMessageUrl = (id: string,) => {




  return `/v1/scheduled/${id}`
}

/**
 * @summary Change the time or text of a scheduled message
 */
export const updateScheduledMessage = async (id: string,
    updateScheduledBody: UpdateScheduledBody, options?: Parameters<typeof apiFetch>[1]): Promise<ScheduledMessage> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<ScheduledMessage>(getUpdateScheduledMessageUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateScheduledBody)
  }
);}



export const getCancelScheduledMessageUrl = (id: string,) => {




  return `/v1/scheduled/${id}`
}

/**
 * @summary Remove a scheduled message
 */
export const cancelScheduledMessage = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

  return apiFetch<OkResponse>(getCancelScheduledMessageUrl(id),
  {
    ...options,
    method: 'DELETE'


  }
);}



export const getSendScheduledMessageNowUrl = (id: string,) => {




  return `/v1/scheduled/${id}/send`
}

/**
 * @summary Send a scheduled message now
 */
export const sendScheduledMessageNow = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<Message> => {

  return apiFetch<Message>(getSendScheduledMessageNowUrl(id),
  {
    ...options,
    method: 'POST'


  }
);}



export const getDispatchScheduledMessagesUrl = () => {




  return `/v1/internal/dispatch`
}

/**
 * @summary Send the scheduled messages that are due (the scheduled function, every minute)
 */
export const dispatchScheduledMessages = async ( options?: Parameters<typeof apiFetch>[1]): Promise<DispatchResponse> => {

  return apiFetch<DispatchResponse>(getDispatchScheduledMessagesUrl(),
  {
    ...options,
    method: 'POST'


  }
);}



export const getGetNotificationSettingsUrl = () => {




  return `/v1/me/notification-settings`
}

/**
 * @summary Which chats notify, and whether notifications show the sender and text (O-19)
 */
export const getNotificationSettings = async ( options?: Parameters<typeof apiFetch>[1]): Promise<NotificationSettings> => {

  return apiFetch<NotificationSettings>(getGetNotificationSettingsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getUpdateNotificationSettingsUrl = () => {




  return `/v1/me/notification-settings`
}

/**
 * @summary Change notification settings
 */
export const updateNotificationSettings = async (updateNotificationSettingsBody: UpdateNotificationSettingsBody, options?: Parameters<typeof apiFetch>[1]): Promise<NotificationSettings> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<NotificationSettings>(getUpdateNotificationSettingsUrl(),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(updateNotificationSettingsBody)
  }
);}



export const getGetBadgeUrl = () => {




  return `/v1/me/badge`
}

/**
 * @summary The badge count (unread messages in chats that are not muted)
 */
export const getBadge = async ( options?: Parameters<typeof apiFetch>[1]): Promise<BadgeResponse> => {

  return apiFetch<BadgeResponse>(getGetBadgeUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getRealtimeViewingUrl = () => {




  return `/v1/realtime/viewing`
}

/**
 * @summary The chat this device shows (not pushed about it)
 */
export const realtimeViewing = async (viewingBody: ViewingBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getRealtimeViewingUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(viewingBody)
  }
);}



export const getSearchEverywhereUrl = (params?: SearchEverywhereParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/search?${stringifiedParams}` : `/v1/search`
}

/**
 * @summary Messages, files, images and voice messages in every chat the user is in
 */
export const searchEverywhere = async (params?: SearchEverywhereParams, options?: Parameters<typeof apiFetch>[1]): Promise<GlobalSearchResponse> => {

  return apiFetch<GlobalSearchResponse>(getSearchEverywhereUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminStatsUrl = () => {




  return `/v1/admin/stats`
}

/**
 * @summary System statistics
 */
export const adminStats = async ( options?: Parameters<typeof apiFetch>[1]): Promise<AdminStats> => {

  return apiFetch<AdminStats>(getAdminStatsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminListUsersUrl = (params?: AdminListUsersParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/users?${stringifiedParams}` : `/v1/admin/users`
}

/**
 * @summary Users by phone, name or username, and status
 */
export const adminListUsers = async (params?: AdminListUsersParams, options?: Parameters<typeof apiFetch>[1]): Promise<AdminUsersResponse> => {

  return apiFetch<AdminUsersResponse>(getAdminListUsersUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminGetUserUrl = (id: string,) => {




  return `/v1/admin/users/${id}`
}

/**
 * @summary One user: account, sessions, counts, account history
 */
export const adminGetUser = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<AdminUserDetail> => {

  return apiFetch<AdminUserDetail>(getAdminGetUserUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminUserActionUrl = (id: string,) => {




  return `/v1/admin/users/${id}/action`
}

/**
 * @summary Suspend, reactivate, end sessions (every admin); ban, delete (Super Admin)
 */
export const adminUserAction = async (id: string,
    adminUserActionBody: AdminUserActionBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminUserDetail> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminUserDetail>(getAdminUserActionUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminUserActionBody)
  }
);}



export const getAdminListChatsUrl = (params?: AdminListChatsParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/chats?${stringifiedParams}` : `/v1/admin/chats`
}

/**
 * @summary Groups and channels
 */
export const adminListChats = async (params?: AdminListChatsParams, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatsResponse> => {

  return apiFetch<AdminChatsResponse>(getAdminListChatsUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminCreateChatUrl = () => {




  return `/v1/admin/chats`
}

/**
 * @summary Create a group or channel owned by a user (Super Admin)
 */
export const adminCreateChat = async (adminCreateChatBody: AdminCreateChatBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatDetail> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminChatDetail>(getAdminCreateChatUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminCreateChatBody)
  }
);}



export const getAdminGetChatUrl = (id: string,) => {




  return `/v1/admin/chats/${id}`
}

/**
 * @summary One group or channel: settings and admins (never its messages, O-18)
 */
export const adminGetChat = async (id: string, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatDetail> => {

  return apiFetch<AdminChatDetail>(getAdminGetChatUrl(id),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminUpdateChatUrl = (id: string,) => {




  return `/v1/admin/chats/${id}`
}

/**
 * @summary Edit, permissions, member privacy, public or private (Super Admin)
 */
export const adminUpdateChat = async (id: string,
    adminUpdateChatBody: AdminUpdateChatBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatDetail> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminChatDetail>(getAdminUpdateChatUrl(id),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminUpdateChatBody)
  }
);}



export const getAdminDeleteChatUrl = (id: string,) => {




  return `/v1/admin/chats/${id}/delete`
}

/**
 * @summary Delete a group or channel; its history stays (Super Admin)
 */
export const adminDeleteChat = async (id: string,
    adminChatReasonBody: AdminChatReasonBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatDetail> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminChatDetail>(getAdminDeleteChatUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminChatReasonBody)
  }
);}



export const getAdminListChatMembersUrl = (id: string,
    params?: AdminListChatMembersParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/chats/${id}/members?${stringifiedParams}` : `/v1/admin/chats/${id}/members`
}

/**
 * @summary Members or subscribers
 */
export const adminListChatMembers = async (id: string,
    params?: AdminListChatMembersParams, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatMembersResponse> => {

  return apiFetch<AdminChatMembersResponse>(getAdminListChatMembersUrl(id,params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminAddChatMembersUrl = (id: string,) => {




  return `/v1/admin/chats/${id}/members`
}

/**
 * @summary Add members or subscribers (Super Admin)
 */
export const adminAddChatMembers = async (id: string,
    adminAddChatMembersBody: AdminAddChatMembersBody, options?: Parameters<typeof apiFetch>[1]): Promise<AddMembersResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AddMembersResponse>(getAdminAddChatMembersUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminAddChatMembersBody)
  }
);}



export const getAdminUpdateChatMemberUrl = (id: string,
    userId: string,) => {




  return `/v1/admin/chats/${id}/members/${userId}`
}

/**
 * @summary Make owner or admin, change rights, restrict (Super Admin)
 */
export const adminUpdateChatMember = async (id: string,
    userId: string,
    adminUpdateChatMemberBody: AdminUpdateChatMemberBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminChatMember> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminChatMember>(getAdminUpdateChatMemberUrl(id,userId),
  {
    ...options,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminUpdateChatMemberBody)
  }
);}



export const getAdminRemoveChatMemberUrl = (id: string,
    userId: string,) => {




  return `/v1/admin/chats/${id}/members/${userId}/remove`
}

/**
 * @summary Remove a member or subscriber (Super Admin)
 */
export const adminRemoveChatMember = async (id: string,
    userId: string,
    adminChatReasonBody: AdminChatReasonBody, options?: Parameters<typeof apiFetch>[1]): Promise<OkResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<OkResponse>(getAdminRemoveChatMemberUrl(id,userId),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminChatReasonBody)
  }
);}



export const getAdminListReportsUrl = (params?: AdminListReportsParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/reports?${stringifiedParams}` : `/v1/admin/reports`
}

/**
 * @summary Reports, open or decided, with the reported message only (O-18)
 */
export const adminListReports = async (params?: AdminListReportsParams, options?: Parameters<typeof apiFetch>[1]): Promise<AdminReportsResponse> => {

  return apiFetch<AdminReportsResponse>(getAdminListReportsUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminDecideReportUrl = (id: string,) => {




  return `/v1/admin/reports/${id}/decision`
}

/**
 * @summary Dismiss, remove the message, suspend or ban (Super Admin) the reported user
 */
export const adminDecideReport = async (id: string,
    adminDecideReportBody: AdminDecideReportBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminReport> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminReport>(getAdminDecideReportUrl(id),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminDecideReportBody)
  }
);}



export const getAdminAuditHistoryUrl = (params: AdminAuditHistoryParams,) => {
  const normalizedParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {

    if (value !== undefined) {
      normalizedParams.append(key, value === null ? 'null' : String(value))
    }
  });

  const stringifiedParams = normalizedParams.toString();

  return stringifiedParams.length > 0 ? `/v1/admin/audit?${stringifiedParams}` : `/v1/admin/audit`
}

/**
 * @summary The permanent history for an investigation, with a reason; each view recorded (Super Admin)
 */
export const adminAuditHistory = async (params: AdminAuditHistoryParams, options?: Parameters<typeof apiFetch>[1]): Promise<AdminAuditResponse> => {

  return apiFetch<AdminAuditResponse>(getAdminAuditHistoryUrl(params),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminListBroadcastsUrl = () => {




  return `/v1/admin/broadcasts`
}

/**
 * @summary Broadcast notifications sent (Super Admin)
 */
export const adminListBroadcasts = async ( options?: Parameters<typeof apiFetch>[1]): Promise<AdminBroadcastsResponse> => {

  return apiFetch<AdminBroadcastsResponse>(getAdminListBroadcastsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminSendBroadcastUrl = () => {




  return `/v1/admin/broadcasts`
}

/**
 * @summary Send a notification to everyone or one group or channel (O-20, Super Admin)
 */
export const adminSendBroadcast = async (adminBroadcastBody: AdminBroadcastBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminBroadcast> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<AdminBroadcast>(getAdminSendBroadcastUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminBroadcastBody)
  }
);}



export const getAdminGifSettingsUrl = () => {




  return `/v1/admin/settings/gifs`
}

/**
 * @summary Whether a GIPHY key is set (never returned)
 */
export const adminGifSettings = async ( options?: Parameters<typeof apiFetch>[1]): Promise<GifSettingsResponse> => {

  return apiFetch<GifSettingsResponse>(getAdminGifSettingsUrl(),
  {
    ...options,
    method: 'GET'


  }
);}



export const getAdminSetGifKeyUrl = () => {




  return `/v1/admin/settings/gifs`
}

/**
 * @summary Set or remove the GIPHY key (Super Admin)
 */
export const adminSetGifKey = async (gifSettingsBody: GifSettingsBody, options?: Parameters<typeof apiFetch>[1]): Promise<GifSettingsResponse> => {

    const getHeaders = (h?: NonNullable<RequestInit['headers']>): Record<string, string | readonly string[]> => {
    if (!h) return {};
    if (h instanceof Headers) return Object.fromEntries(h.entries());
    if (Symbol.iterator in h) {
      return Object.fromEntries(
        Array.from(h as Iterable<Iterable<string>>, (entry) => Array.from(entry) as [string, string]),
      );
    }
    const headers: Record<string, string | readonly string[]> = {};
    for (const [name, value] of Object.entries<string | readonly string[] | undefined>(h)) {
      if (value !== undefined) headers[name] = value;
    }
    return headers;
  };
return apiFetch<GifSettingsResponse>(getAdminSetGifKeyUrl(),
  {
    ...options,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(gifSettingsBody)
  }
);}
