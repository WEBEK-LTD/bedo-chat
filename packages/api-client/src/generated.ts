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

export type ReadyResponseChecksRedisStatus = typeof ReadyResponseChecksRedisStatus[keyof typeof ReadyResponseChecksRedisStatus];


export const ReadyResponseChecksRedisStatus = {
  up: 'up',
  down: 'down',
} as const;

export type ReadyResponseChecksRedis = {
  status: ReadyResponseChecksRedisStatus;
  /** @minimum 0 */
  latencyMs: number;
};

export type ReadyResponseChecks = {
  database: ReadyResponseChecksDatabase;
  redis: ReadyResponseChecksRedis;
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

export interface AdminOtpRequestBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
}

export interface AdminOtpVerifyBody {
  /**
     * @minLength 5
     * @maxLength 32
     */
  phone: string;
  /** @pattern ^\d{6}$ */
  code: string;
}

export type AdminOtpVerifyResponseStatus = typeof AdminOtpVerifyResponseStatus[keyof typeof AdminOtpVerifyResponseStatus];


export const AdminOtpVerifyResponseStatus = {
  totp_required: 'totp_required',
} as const;

export interface AdminOtpVerifyResponse {
  status: AdminOtpVerifyResponseStatus;
  pendingToken: string;
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



export const getAdminRequestCodeUrl = () => {




  return `/v1/admin/auth/otp/request`
}

/**
 * @summary Send an admin sign-in code
 */
export const adminRequestCode = async (adminOtpRequestBody: AdminOtpRequestBody, options?: Parameters<typeof apiFetch>[1]): Promise<OtpRequestResponse> => {

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
return apiFetch<OtpRequestResponse>(getAdminRequestCodeUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminOtpRequestBody)
  }
);}



export const getAdminVerifyCodeUrl = () => {




  return `/v1/admin/auth/otp/verify`
}

/**
 * @summary Verify the admin phone code
 */
export const adminVerifyCode = async (adminOtpVerifyBody: AdminOtpVerifyBody, options?: Parameters<typeof apiFetch>[1]): Promise<AdminOtpVerifyResponse> => {

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
return apiFetch<AdminOtpVerifyResponse>(getAdminVerifyCodeUrl(),
  {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders(options?.headers) },
    body: JSON.stringify(adminOtpVerifyBody)
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
