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

export type PrivacyCallsFrom = typeof PrivacyCallsFrom[keyof typeof PrivacyCallsFrom];


export const PrivacyCallsFrom = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export interface Privacy {
  phoneVisibility: PrivacyPhoneVisibility;
  lastSeenVisibility: PrivacyLastSeenVisibility;
  photoVisibility: PrivacyPhotoVisibility;
  messagesFrom: PrivacyMessagesFrom;
  callsFrom: PrivacyCallsFrom;
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

export type UpdatePrivacyBodyCallsFrom = typeof UpdatePrivacyBodyCallsFrom[keyof typeof UpdatePrivacyBodyCallsFrom];


export const UpdatePrivacyBodyCallsFrom = {
  everyone: 'everyone',
  nobody: 'nobody',
} as const;

export interface UpdatePrivacyBody {
  phoneVisibility?: UpdatePrivacyBodyPhoneVisibility;
  lastSeenVisibility?: UpdatePrivacyBodyLastSeenVisibility;
  photoVisibility?: UpdatePrivacyBodyPhotoVisibility;
  messagesFrom?: UpdatePrivacyBodyMessagesFrom;
  callsFrom?: UpdatePrivacyBodyCallsFrom;
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
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemPeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

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
};

export type ChatsResponseChatsItemLastMessageKind = typeof ChatsResponseChatsItemLastMessageKind[keyof typeof ChatsResponseChatsItemLastMessageKind];


export const ChatsResponseChatsItemLastMessageKind = {
  text: 'text',
} as const;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
} | null;

/**
 * @nullable
 */
export type ChatsResponseChatsItemLastMessageForwardedFrom = {
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
  peer: ChatsResponseChatsItemPeer;
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
  pinned: boolean;
  /** @nullable */
  pinnedAt: string | null;
  archived: boolean;
  folderIds: string[];
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
} as const;

/**
 * @nullable
 */
export type ChatPeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

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
};

export type ChatLastMessageKind = typeof ChatLastMessageKind[keyof typeof ChatLastMessageKind];


export const ChatLastMessageKind = {
  text: 'text',
} as const;

/**
 * @nullable
 */
export type ChatLastMessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
} | null;

/**
 * @nullable
 */
export type ChatLastMessageForwardedFrom = {
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
  peer: ChatPeer;
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
  pinned: boolean;
  /** @nullable */
  pinnedAt: string | null;
  archived: boolean;
  folderIds: string[];
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
}

export type MessagesResponseMessagesItemKind = typeof MessagesResponseMessagesItemKind[keyof typeof MessagesResponseMessagesItemKind];


export const MessagesResponseMessagesItemKind = {
  text: 'text',
} as const;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
} | null;

/**
 * @nullable
 */
export type MessagesResponseMessagesItemForwardedFrom = {
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

export interface SendMessageBody {
  clientId: string;
  /** @minLength 1 */
  text: string;
  replyToId?: string;
}

export type MessageKind = typeof MessageKind[keyof typeof MessageKind];


export const MessageKind = {
  text: 'text',
} as const;

/**
 * @nullable
 */
export type MessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
} | null;

/**
 * @nullable
 */
export type MessageForwardedFrom = {
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
  chatread: 'chat.read',
  chatdelivered: 'chat.delivered',
  chatstate: 'chat.state',
  folders: 'folders',
  block: 'block',
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
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemPeerPresence = {
  online: boolean;
  /** @nullable */
  lastSeenAt: string | null;
} | null;

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
};

export type SyncResponseChatsItemLastMessageKind = typeof SyncResponseChatsItemLastMessageKind[keyof typeof SyncResponseChatsItemLastMessageKind];


export const SyncResponseChatsItemLastMessageKind = {
  text: 'text',
} as const;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseChatsItemLastMessageForwardedFrom = {
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
  peer: SyncResponseChatsItemPeer;
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
  pinned: boolean;
  /** @nullable */
  pinnedAt: string | null;
  archived: boolean;
  folderIds: string[];
  createdAt: string;
  /** @nullable */
  lastMessageAt: string | null;
};

export type SyncResponseMessagesItemKind = typeof SyncResponseMessagesItemKind[keyof typeof SyncResponseMessagesItemKind];


export const SyncResponseMessagesItemKind = {
  text: 'text',
} as const;

/**
 * @nullable
 */
export type SyncResponseMessagesItemReplyTo = {
  id: string;
  senderId: string;
  /** @nullable */
  text: string | null;
} | null;

/**
 * @nullable
 */
export type SyncResponseMessagesItemForwardedFrom = {
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
