import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as admin from './admin.js';
import * as consoleApi from './admin-console.js';
import * as auth from './auth.js';
import { CSRF_HEADER, errorEnvelopeSchema, okResponseSchema } from './common.js';
import { liveResponseSchema, readyResponseSchema } from './health.js';
import * as channels from './channels.js';
import * as groups from './groups.js';
import * as me from './me.js';
import * as media from './media.js';
import * as msg from './messaging.js';
import * as notifications from './notifications.js';
import * as search from './search.js';

// Adds .openapi() to Zod schemas created from now on. Only this module (used by the API build and
// tests) loads it, so clients importing '@bedo/contracts' get plain Zod schemas without the OpenAPI
// library. Zod 4 attaches methods per instance, so the shared schemas are cloned before registration.
extendZodWithOpenApi(z);
const forOpenApi = <T extends z.ZodType>(schema: T): T => schema.clone();

export interface OpenApiDocumentOptions {
  version: string;
  serverUrl?: string;
}

/**
 * Builds the OpenAPI 3.1 document from the shared Zod contracts.
 * Every endpoint added in later phases registers its request and response schemas here,
 * so the document, the server's response validation and the generated client never drift apart.
 */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export function buildOpenApiDocument(options: OpenApiDocumentOptions): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  const errorEnvelope = registry.register('ErrorEnvelope', forOpenApi(errorEnvelopeSchema));
  const liveResponse = registry.register('LiveResponse', forOpenApi(liveResponseSchema));
  const readyResponse = registry.register('ReadyResponse', forOpenApi(readyResponseSchema));

  registry.registerPath({
    method: 'get',
    path: '/health/live',
    operationId: 'getHealthLive',
    tags: ['Health'],
    summary: 'Process liveness',
    responses: {
      200: { description: 'The API process is running.', content: { 'application/json': { schema: liveResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/health/ready',
    operationId: 'getHealthReady',
    tags: ['Health'],
    summary: 'Readiness of the API and its dependencies',
    responses: {
      200: {
        description: 'Postgres is reachable (D-36: the only dependency).',
        content: { 'application/json': { schema: readyResponse } },
      },
      503: {
        description: 'Postgres is unreachable.',
        content: { 'application/json': { schema: readyResponse } },
      },
      500: { description: 'Unexpected error.', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });


  // ------------------------------------------------------------------ Phase 2: accounts (D-11 … D-23)
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'Short-lived access token from sign-in or refresh.',
  });
  registry.registerComponent('securitySchemes', 'refreshCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: auth.REFRESH_COOKIE,
    description: 'httpOnly rotating refresh token (web).',
  });
  registry.registerComponent('securitySchemes', 'adminSession', {
    type: 'apiKey',
    in: 'cookie',
    name: admin.ADMIN_SESSION_COOKIE,
    description: 'httpOnly admin session cookie.',
  });
  registry.registerComponent('securitySchemes', 'csrfHeader', {
    type: 'apiKey',
    in: 'header',
    name: CSRF_HEADER,
    description: 'Required (value "1"), together with an allowed Origin, on cookie-authenticated changes.',
  });
  registry.registerComponent('securitySchemes', 'dispatchHeader', {
    type: 'apiKey',
    in: 'header',
    name: 'x-bedo-dispatch',
    description: "Phase 6: the scheduled function's token (an HMAC of a fixed purpose with the API's access-token secret).",
  });

  type Access = 'public' | 'publicCsrf' | 'user' | 'refresh' | 'admin' | 'adminCsrf' | 'dispatch';
  const SECURITY: Record<Access, Array<Record<string, string[]>> | undefined> = {
    public: undefined,
    publicCsrf: [{ csrfHeader: [] }],
    user: [{ bearerAuth: [] }],
    refresh: [{ refreshCookie: [], csrfHeader: [] }],
    admin: [{ adminSession: [] }],
    adminCsrf: [{ adminSession: [], csrfHeader: [] }],
    dispatch: [{ dispatchHeader: [] }],
  };
  const idParams = z.object({ id: z.string().uuid() });
  const schemas = new Map<z.ZodType, z.ZodType>();
  const named = (name: string, schema: z.ZodType) => {
    const existing = schemas.get(schema);
    if (existing) {
      return existing;
    }
    const registered = registry.register(name, forOpenApi(schema));
    schemas.set(schema, registered);
    return registered;
  };

  interface Route {
    method: 'get' | 'post' | 'put' | 'patch' | 'delete';
    path: string;
    operationId: string;
    tag: string;
    summary: string;
    access: Access;
    body?: [string, z.ZodType];
    query?: z.ZodObject;
    params?: z.ZodObject;
    response: [string, z.ZodType] | { binary: string };
  }

  const routes: Route[] = [
    // Sign-in (D-06, D-11, D-22)
    { method: 'post', path: '/v1/auth/otp/request', operationId: 'requestSignInCode', tag: 'Auth', summary: 'Send a sign-in code by WhatsApp (same answer for every number)', access: 'public', body: ['OtpRequestBody', auth.otpRequestBodySchema], response: ['OtpRequestResponse', auth.otpRequestResponseSchema] },
    { method: 'post', path: '/v1/auth/otp/verify', operationId: 'verifySignInCode', tag: 'Auth', summary: 'Verify the code; signs in or asks for the 2-Step password', access: 'public', body: ['OtpVerifyBody', auth.otpVerifyBodySchema], response: ['OtpVerifyResponse', auth.otpVerifyResponseSchema] },
    { method: 'post', path: '/v1/auth/two-step/verify', operationId: 'verifyTwoStep', tag: 'Auth', summary: 'Complete sign-in with the 2-Step Verification password', access: 'public', body: ['TwoStepVerifyBody', auth.twoStepVerifyBodySchema], response: ['AuthenticatedResponse', auth.authenticatedResponseSchema] },
    { method: 'post', path: '/v1/auth/refresh', operationId: 'refreshSession', tag: 'Auth', summary: 'Rotate the refresh token and get a new access token', access: 'refresh', response: ['AuthenticatedResponse', auth.authenticatedResponseSchema] },
    { method: 'post', path: '/v1/auth/logout', operationId: 'logout', tag: 'Auth', summary: 'End this session', access: 'refresh', response: ['OkResponse', okResponseSchema] },
    // Profile, privacy, phone number
    { method: 'get', path: '/v1/me', operationId: 'getMe', tag: 'Me', summary: 'Current account', access: 'user', response: ['Me', me.meSchema] },
    { method: 'patch', path: '/v1/me', operationId: 'updateMe', tag: 'Me', summary: 'Change name, username or bio', access: 'user', body: ['UpdateMeBody', me.updateMeBodySchema], response: ['Me', me.meSchema] },
    { method: 'get', path: '/v1/me/privacy', operationId: 'getPrivacy', tag: 'Me', summary: 'Privacy settings', access: 'user', response: ['Privacy', me.privacySchema] },
    { method: 'patch', path: '/v1/me/privacy', operationId: 'updatePrivacy', tag: 'Me', summary: 'Change privacy settings', access: 'user', body: ['UpdatePrivacyBody', me.updatePrivacyBodySchema], response: ['Privacy', me.privacySchema] },
    { method: 'post', path: '/v1/me/photo/upload', operationId: 'startPhotoUpload', tag: 'Me', summary: 'One-time signed upload URL for a new profile picture', access: 'user', body: ['PhotoUploadBody', me.photoUploadBodySchema], response: ['PhotoUploadResponse', me.photoUploadResponseSchema] },
    { method: 'post', path: '/v1/me/photo/confirm', operationId: 'confirmPhotoUpload', tag: 'Me', summary: 'Check the uploaded picture and make it the profile picture', access: 'user', body: ['PhotoConfirmBody', me.photoConfirmBodySchema], response: ['Me', me.meSchema] },
    { method: 'delete', path: '/v1/me/photo', operationId: 'removePhoto', tag: 'Me', summary: 'Remove the profile picture', access: 'user', response: ['Me', me.meSchema] },
    { method: 'post', path: '/v1/me/phone/request', operationId: 'requestPhoneChange', tag: 'Me', summary: 'Send a code to the new phone number', access: 'user', body: ['PhoneChangeRequestBody', me.phoneChangeRequestBodySchema], response: ['OtpRequestResponse', auth.otpRequestResponseSchema] },
    { method: 'post', path: '/v1/me/phone/verify', operationId: 'verifyPhoneChange', tag: 'Me', summary: 'Confirm the new phone number', access: 'user', body: ['PhoneChangeVerifyBody', me.phoneChangeVerifyBodySchema], response: ['Me', me.meSchema] },
    // Devices (sessions)
    { method: 'get', path: '/v1/me/sessions', operationId: 'listSessions', tag: 'Devices', summary: 'Signed-in devices', access: 'user', response: ['SessionsResponse', me.sessionsResponseSchema] },
    { method: 'post', path: '/v1/me/sessions/terminate-others', operationId: 'terminateOtherSessions', tag: 'Devices', summary: 'Sign out every other device', access: 'user', response: ['OkResponse', okResponseSchema] },
    { method: 'delete', path: '/v1/me/sessions/{id}', operationId: 'terminateSession', tag: 'Devices', summary: 'Sign out one device', access: 'user', params: idParams, response: ['OkResponse', okResponseSchema] },
    // 2-Step Verification
    { method: 'get', path: '/v1/me/two-step', operationId: 'getTwoStep', tag: 'Two-Step', summary: '2-Step Verification status', access: 'user', response: ['TwoStepStatus', me.twoStepStatusSchema] },
    { method: 'put', path: '/v1/me/two-step', operationId: 'setTwoStep', tag: 'Two-Step', summary: 'Turn on or change the 2-Step password', access: 'user', body: ['TwoStepSetBody', me.twoStepSetBodySchema], response: ['TwoStepStatus', me.twoStepStatusSchema] },
    { method: 'post', path: '/v1/me/two-step/disable', operationId: 'disableTwoStep', tag: 'Two-Step', summary: 'Turn off 2-Step Verification', access: 'user', body: ['TwoStepDisableBody', me.twoStepDisableBodySchema], response: ['TwoStepStatus', me.twoStepStatusSchema] },
    // Security notices and push
    { method: 'get', path: '/v1/me/security-notices', operationId: 'listSecurityNotices', tag: 'Notices', summary: 'Login alerts and account notices', access: 'user', response: ['SecurityNoticesResponse', me.securityNoticesResponseSchema] },
    { method: 'post', path: '/v1/me/security-notices/read', operationId: 'markSecurityNoticesRead', tag: 'Notices', summary: 'Mark notices as read', access: 'user', body: ['MarkNoticesReadBody', me.markNoticesReadBodySchema], response: ['SecurityNoticesResponse', me.securityNoticesResponseSchema] },
    { method: 'get', path: '/v1/push/config', operationId: 'getPushConfig', tag: 'Notices', summary: 'Web Push public key', access: 'public', response: ['PushConfigResponse', me.pushConfigResponseSchema] },
    { method: 'put', path: '/v1/me/push-subscription', operationId: 'savePushSubscription', tag: 'Notices', summary: 'Register this browser for push notifications', access: 'user', body: ['PushSubscriptionBody', me.pushSubscriptionBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'delete', path: '/v1/me/push-subscription', operationId: 'removePushSubscription', tag: 'Notices', summary: 'Stop push notifications on this browser', access: 'user', response: ['OkResponse', okResponseSchema] },
    // Account deletion (D-14)
    { method: 'post', path: '/v1/me/deletion-request', operationId: 'requestAccountDeletion', tag: 'Me', summary: 'Ask an administrator to delete this account', access: 'user', response: ['DeletionRequestResponse', me.deletionRequestResponseSchema] },
    // Admin sign-in (D-19)
    { method: 'post', path: '/v1/admin/auth/password/login', operationId: 'adminPasswordLogin', tag: 'Admin', summary: 'Admin sign-in step 1: phone and password (D-34); the authenticator code follows', access: 'publicCsrf', body: ['AdminPasswordLoginBody', admin.adminPasswordLoginBodySchema], response: ['AdminPasswordLoginResponse', admin.adminPasswordLoginResponseSchema] },
    { method: 'post', path: '/v1/admin/auth/password/setup', operationId: 'adminPasswordSetup', tag: 'Admin', summary: 'Set an admin password with an owner-issued setup token (D-34); signs nobody in', access: 'publicCsrf', body: ['AdminPasswordSetupBody', admin.adminPasswordSetupBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/admin/auth/totp/verify', operationId: 'adminVerifyTotp', tag: 'Admin', summary: 'Verify the authenticator-app code and start the admin session', access: 'publicCsrf', body: ['AdminTotpVerifyBody', admin.adminTotpVerifyBodySchema], response: ['AdminSessionResponse', admin.adminSessionResponseSchema] },
    { method: 'post', path: '/v1/admin/auth/totp/setup', operationId: 'adminSetupTotp', tag: 'Admin', summary: 'First sign-in of an account created by SQL: generate the authenticator secret (Phase 3.1)', access: 'publicCsrf', body: ['AdminTotpSetupBody', admin.adminTotpSetupBodySchema], response: ['AdminTotpSetupResponse', admin.adminTotpSetupResponseSchema] },
    // Initial setup (Phase 3.1): open only after the owner runs app.open_admin_bootstrap() by SQL
    { method: 'get', path: '/v1/admin/bootstrap', operationId: 'adminBootstrapStatus', tag: 'Admin', summary: 'Whether the one-time initial setup is open', access: 'publicCsrf', response: ['AdminBootstrapStatusResponse', admin.adminBootstrapStatusResponseSchema] },
    { method: 'post', path: '/v1/admin/bootstrap/waabek-key', operationId: 'adminBootstrapSetWaabekKey', tag: 'Admin', summary: 'Initial setup: store the first Waabek API key (setup token required)', access: 'publicCsrf', body: ['AdminBootstrapWaabekKeyBody', admin.adminBootstrapWaabekKeyBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/admin/bootstrap/test-message', operationId: 'adminBootstrapTestMessage', tag: 'Admin', summary: 'Initial setup: send a WhatsApp test message to the Super Admin (setup token required)', access: 'publicCsrf', body: ['AdminBootstrapTestBody', admin.adminBootstrapTestBodySchema], response: ['WaabekTestResponse', admin.waabekTestResponseSchema] },
    // Owner-only Waabek key recovery (D-33): open only after the owner runs app.open_otp_settings_recovery() by SQL
    { method: 'get', path: '/v1/admin/otp-recovery', operationId: 'adminOtpRecoveryStatus', tag: 'Admin', summary: 'Whether an owner-opened Waabek key recovery is open', access: 'publicCsrf', response: ['OtpRecoveryStatusResponse', admin.otpRecoveryStatusResponseSchema] },
    { method: 'post', path: '/v1/admin/otp-recovery/waabek-key', operationId: 'adminOtpRecoverySetWaabekKey', tag: 'Admin', summary: 'Recovery: store a new Waabek API key (recovery token required; signs nobody in)', access: 'publicCsrf', body: ['OtpRecoveryWaabekKeyBody', admin.otpRecoveryWaabekKeyBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/admin/otp-recovery/test-message', operationId: 'adminOtpRecoveryTestMessage', tag: 'Admin', summary: 'Recovery: send a WhatsApp test message to the first Super Admin (recovery token required)', access: 'publicCsrf', body: ['OtpRecoveryTestBody', admin.otpRecoveryTestBodySchema], response: ['WaabekTestResponse', admin.waabekTestResponseSchema] },
    { method: 'get', path: '/v1/admin/session', operationId: 'adminSession', tag: 'Admin', summary: 'Current admin', access: 'admin', response: ['AdminSessionResponse', admin.adminSessionResponseSchema] },
    { method: 'post', path: '/v1/admin/session/logout', operationId: 'adminLogout', tag: 'Admin', summary: 'End the admin session', access: 'adminCsrf', response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/admin/account/password', operationId: 'adminChangePassword', tag: 'Admin', summary: 'Change one\'s own password with the current password and an authenticator code (D-34); ends the other sessions', access: 'adminCsrf', body: ['AdminPasswordChangeBody', admin.adminPasswordChangeBodySchema], response: ['AdminPasswordChangeResponse', admin.adminPasswordChangeResponseSchema] },
    // Admin areas (D-20)
    { method: 'get', path: '/v1/admin/phone-list', operationId: 'adminListPhones', tag: 'Admin', summary: 'Academy phone list', access: 'admin', query: admin.phoneListQuerySchema, response: ['PhoneListResponse', admin.phoneListResponseSchema] },
    { method: 'post', path: '/v1/admin/phone-list', operationId: 'adminAddPhone', tag: 'Admin', summary: 'Add a number (Super Admin)', access: 'adminCsrf', body: ['PhoneListAddBody', admin.phoneListAddBodySchema], response: ['PhoneListAddResponse', admin.phoneListAddResponseSchema] },
    { method: 'post', path: '/v1/admin/phone-list/import', operationId: 'adminImportPhones', tag: 'Admin', summary: 'Import numbers from CSV (Super Admin)', access: 'adminCsrf', body: ['PhoneListImportBody', admin.phoneListImportBodySchema], response: ['PhoneListImportResponse', admin.phoneListImportResponseSchema] },
    { method: 'get', path: '/v1/admin/deletion-requests', operationId: 'adminListDeletionRequests', tag: 'Admin', summary: 'Account deletion requests', access: 'admin', query: admin.deletionRequestListQuerySchema, response: ['DeletionRequestListResponse', admin.deletionRequestListResponseSchema] },
    { method: 'get', path: '/v1/admin/deletion-requests/{id}', operationId: 'adminDeletionRequest', tag: 'Admin', summary: 'One request with account activity and history', access: 'admin', params: idParams, response: ['DeletionRequestDetail', admin.deletionRequestDetailSchema] },
    { method: 'post', path: '/v1/admin/deletion-requests/{id}/approve', operationId: 'adminApproveDeletion', tag: 'Admin', summary: 'Approve and delete the account (Super Admin)', access: 'adminCsrf', params: idParams, body: ['DeletionDecisionBody', admin.deletionDecisionBodySchema], response: ['DeletionRequestDetail', admin.deletionRequestDetailSchema] },
    { method: 'post', path: '/v1/admin/deletion-requests/{id}/reject', operationId: 'adminRejectDeletion', tag: 'Admin', summary: 'Reject the request (Super Admin)', access: 'adminCsrf', params: idParams, body: ['DeletionDecisionBody', admin.deletionDecisionBodySchema], response: ['DeletionRequestDetail', admin.deletionRequestDetailSchema] },
    { method: 'post', path: '/v1/admin/users/two-step-reset', operationId: 'adminResetTwoStep', tag: 'Admin', summary: 'Reset a user\'s 2-Step password after an identity check (Super Admin)', access: 'adminCsrf', body: ['TwoStepResetBody', admin.twoStepResetBodySchema], response: ['TwoStepResetResponse', admin.twoStepResetResponseSchema] },
    // OTP / WhatsApp (Waabek) settings (D-32, Super Admin)
    { method: 'get', path: '/v1/admin/settings/otp', operationId: 'adminOtpSettings', tag: 'Admin', summary: 'OTP delivery settings; the Waabek API key is never returned (Super Admin)', access: 'admin', response: ['OtpSettingsResponse', admin.otpSettingsResponseSchema] },
    { method: 'put', path: '/v1/admin/settings/otp/waabek-key', operationId: 'adminReplaceWaabekKey', tag: 'Admin', summary: 'Replace the Waabek API key; needs a current authenticator code (Super Admin)', access: 'adminCsrf', body: ['OtpSettingsReplaceKeyBody', admin.otpSettingsReplaceKeyBodySchema], response: ['OtpSettingsReplaceKeyResponse', admin.otpSettingsReplaceKeyResponseSchema] },
    { method: 'post', path: '/v1/admin/settings/otp/test-message', operationId: 'adminSendWaabekTest', tag: 'Admin', summary: 'Send a WhatsApp test message to your own number (Super Admin)', access: 'adminCsrf', response: ['WaabekTestResponse', admin.waabekTestResponseSchema] },
    // Phase 3: messaging core (D-29 to D-31)
    { method: 'get', path: '/v1/users/search', operationId: 'searchUsers', tag: 'Users', summary: 'Find a user to message by name or username (P-25)', access: 'user', query: msg.userSearchQuerySchema, response: ['UserSearchResponse', msg.userSearchResponseSchema] },
    { method: 'get', path: '/v1/users/{id}', operationId: 'getUser', tag: 'Users', summary: 'Another user as the signed-in user may see them', access: 'user', params: idParams, response: ['Peer', msg.peerSchema] },
    { method: 'post', path: '/v1/users/{id}/block', operationId: 'blockUser', tag: 'Users', summary: 'Block a user (P-26, P-30)', access: 'user', params: idParams, response: ['OkResponse', okResponseSchema] },
    { method: 'delete', path: '/v1/users/{id}/block', operationId: 'unblockUser', tag: 'Users', summary: 'Unblock a user', access: 'user', params: idParams, response: ['OkResponse', okResponseSchema] },
    { method: 'get', path: '/v1/chats', operationId: 'listChats', tag: 'Chats', summary: 'Chat list with unread counts and chat-list state', access: 'user', response: ['ChatsResponse', msg.chatsResponseSchema] },
    { method: 'post', path: '/v1/chats', operationId: 'openChat', tag: 'Chats', summary: 'Open the private chat with a user (existing or new)', access: 'user', body: ['CreateChatBody', msg.createChatBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'get', path: '/v1/chats/{id}', operationId: 'getChat', tag: 'Chats', summary: 'One chat', access: 'user', params: idParams, response: ['Chat', msg.chatSchema] },
    { method: 'get', path: '/v1/chats/{id}/messages', operationId: 'listMessages', tag: 'Chats', summary: 'Chat history in pages of up to 50 (P-17)', access: 'user', params: idParams, query: msg.messageHistoryQuerySchema, response: ['MessagesResponse', msg.messagesResponseSchema] },
    { method: 'post', path: '/v1/chats/{id}/messages', operationId: 'sendMessage', tag: 'Chats', summary: 'Send a message (idempotent by client id)', access: 'user', params: idParams, body: ['SendMessageBody', msg.sendMessageBodySchema], response: ['Message', msg.messageSchema] },
    { method: 'get', path: '/v1/chats/{id}/search', operationId: 'searchChat', tag: 'Chats', summary: 'Search messages in one chat', access: 'user', params: idParams, query: msg.chatSearchQuerySchema, response: ['MessagesResponse', msg.messagesResponseSchema] },
    { method: 'get', path: '/v1/chats/{id}/pins', operationId: 'listPinnedMessages', tag: 'Chats', summary: 'Pinned messages (P-22)', access: 'user', params: idParams, response: ['MessagesResponse', msg.messagesResponseSchema] },
    { method: 'post', path: '/v1/chats/{id}/read', operationId: 'markChatRead', tag: 'Chats', summary: 'Mark as read up to a message (P-20)', access: 'user', params: idParams, body: ['ReadChatBody', msg.readChatBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'post', path: '/v1/chats/{id}/delivered', operationId: 'markChatDelivered', tag: 'Chats', summary: 'This device received the messages up to a seq', access: 'user', params: idParams, body: ['ReadChatBody', msg.readChatBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'patch', path: '/v1/chats/{id}/state', operationId: 'updateChatState', tag: 'Chats', summary: 'Pin, archive or mark as unread (P-19, P-20)', access: 'user', params: idParams, body: ['ChatStateBody', msg.chatStateBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'patch', path: '/v1/messages/{id}', operationId: 'editMessage', tag: 'Messages', summary: 'Edit one\'s own message (O-27)', access: 'user', params: idParams, body: ['EditMessageBody', msg.editMessageBodySchema], response: ['Message', msg.messageSchema] },
    { method: 'post', path: '/v1/messages/delete', operationId: 'deleteMessages', tag: 'Messages', summary: 'Delete for me or for both sides (P-29)', access: 'user', body: ['DeleteMessagesBody', msg.deleteMessagesBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/messages/forward', operationId: 'forwardMessages', tag: 'Messages', summary: 'Forward up to 100 messages to up to 10 chats (P-23)', access: 'user', body: ['ForwardMessagesBody', msg.forwardMessagesBodySchema], response: ['MessagesResponse', msg.messagesResponseSchema] },
    { method: 'put', path: '/v1/messages/{id}/pin', operationId: 'pinMessage', tag: 'Messages', summary: 'Pin a message for both participants (P-22)', access: 'user', params: idParams, response: ['Message', msg.messageSchema] },
    { method: 'delete', path: '/v1/messages/{id}/pin', operationId: 'unpinMessage', tag: 'Messages', summary: 'Unpin a message', access: 'user', params: idParams, response: ['Message', msg.messageSchema] },
    { method: 'get', path: '/v1/folders', operationId: 'listFolders', tag: 'Folders', summary: 'Chat folders (P-21)', access: 'user', response: ['FoldersResponse', msg.foldersResponseSchema] },
    { method: 'post', path: '/v1/folders', operationId: 'createFolder', tag: 'Folders', summary: 'Create a folder', access: 'user', body: ['CreateFolderBody', msg.createFolderBodySchema], response: ['FoldersResponse', msg.foldersResponseSchema] },
    { method: 'patch', path: '/v1/folders/{id}', operationId: 'updateFolder', tag: 'Folders', summary: 'Rename a folder or change its chats', access: 'user', params: idParams, body: ['UpdateFolderBody', msg.updateFolderBodySchema], response: ['FoldersResponse', msg.foldersResponseSchema] },
    { method: 'delete', path: '/v1/folders/{id}', operationId: 'deleteFolder', tag: 'Folders', summary: 'Delete a folder (its chats stay)', access: 'user', params: idParams, response: ['FoldersResponse', msg.foldersResponseSchema] },
    { method: 'post', path: '/v1/reports', operationId: 'reportUser', tag: 'Safety', summary: 'Report a user or a message (P-27)', access: 'user', body: ['ReportBody', msg.reportBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/screenshot-events', operationId: 'recordScreenshot', tag: 'Safety', summary: 'Screenshot event from the iOS or Android app (P-28)', access: 'user', body: ['ScreenshotEventBody', msg.screenshotEventBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'get', path: '/v1/sync', operationId: 'sync', tag: 'Sync', summary: 'Updates since a seq (P-17)', access: 'user', query: msg.syncQuerySchema, response: ['SyncResponse', msg.syncResponseSchema] },
    // Realtime (D-36): the device listens on Supabase Realtime and talks to the API over HTTP
    { method: 'get', path: '/v1/realtime/channel', operationId: 'getRealtimeChannel', tag: 'Sync', summary: "This device's private realtime channel (signals only, no content)", access: 'user', response: ['RealtimeChannelResponse', msg.realtimeChannelResponseSchema] },
    { method: 'post', path: '/v1/realtime/heartbeat', operationId: 'realtimeHeartbeat', tag: 'Sync', summary: 'Online for the next 60 seconds (every 25 s, P-18); returns the current update seq', access: 'user', response: ['RealtimeHeartbeatResponse', msg.realtimeHeartbeatResponseSchema] },
    { method: 'post', path: '/v1/realtime/typing', operationId: 'realtimeTyping', tag: 'Sync', summary: 'The user is typing in a chat (shown for 6 seconds, P-18)', access: 'user', body: ['RealtimeTypingBody', msg.realtimeTypingBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/realtime/offline', operationId: 'realtimeOffline', tag: 'Sync', summary: 'This device is going away (no longer online)', access: 'user', response: ['OkResponse', okResponseSchema] },
    // Phase 4: media, stickers, GIFs and reactions (D-38)
    { method: 'post', path: '/v1/files/uploads', operationId: 'createUpload', tag: 'Media', summary: 'One-time signed upload URLs for a file to send in a chat', access: 'user', body: ['UploadRequestBody', media.uploadRequestBodySchema], response: ['UploadResponse', media.uploadResponseSchema] },
    { method: 'get', path: '/v1/messages/{id}/file', operationId: 'getMessageFile', tag: 'Media', summary: "A signed link (5 minutes) to a message's file", access: 'user', params: idParams, query: media.fileUrlQuerySchema, response: ['FileUrlResponse', media.fileUrlResponseSchema] },
    { method: 'put', path: '/v1/messages/{id}/reaction', operationId: 'reactToMessage', tag: 'Media', summary: 'React to a message (one reaction per person)', access: 'user', params: idParams, body: ['ReactionBody', media.reactionBodySchema], response: ['Message', msg.messageSchema] },
    { method: 'delete', path: '/v1/messages/{id}/reaction', operationId: 'removeReaction', tag: 'Media', summary: 'Take back one\'s reaction', access: 'user', params: idParams, response: ['Message', msg.messageSchema] },
    { method: 'get', path: '/v1/chats/{id}/media', operationId: 'listChatMedia', tag: 'Media', summary: "A chat's photos and videos, files or voice messages", access: 'user', params: idParams, query: media.chatMediaQuerySchema, response: ['MessagesResponse', msg.messagesResponseSchema] },
    { method: 'get', path: '/v1/stickers', operationId: 'listStickers', tag: 'Media', summary: 'Sticker packs (O-10)', access: 'user', response: ['StickerPacksResponse', media.stickerPacksResponseSchema] },
    { method: 'get', path: '/v1/gifs/search', operationId: 'searchGifs', tag: 'Media', summary: 'Search GIFs, or trending GIFs without a query (O-09)', access: 'user', query: media.gifSearchQuerySchema, response: ['GifSearchResponse', media.gifSearchResponseSchema] },
    { method: 'get', path: '/v1/gifs/preview', operationId: 'getGifPreview', tag: 'Media', summary: 'A GIF preview image (signed link from GIF search)', access: 'public', query: media.gifPreviewQuerySchema, response: { binary: 'image/*' } },
    { method: 'get', path: '/v1/admin/stickers', operationId: 'adminListStickers', tag: 'Admin', summary: 'Sticker packs with removed stickers', access: 'admin', response: ['AdminStickerPacksResponse', media.adminStickerPacksResponseSchema] },
    { method: 'get', path: '/v1/admin/stickers/{id}/image', operationId: 'adminStickerImage', tag: 'Admin', summary: 'A sticker image as base64 (the dashboard shows pictures only from itself)', access: 'admin', params: idParams, response: ['AdminStickerImageResponse', media.adminStickerImageResponseSchema] },
    { method: 'post', path: '/v1/admin/stickers/packs', operationId: 'adminCreateStickerPack', tag: 'Admin', summary: 'Create a sticker pack (Super Admin)', access: 'adminCsrf', body: ['CreateStickerPackBody', media.createStickerPackBodySchema], response: ['AdminStickerPacksResponse', media.adminStickerPacksResponseSchema] },
    { method: 'patch', path: '/v1/admin/stickers/packs/{id}', operationId: 'adminUpdateStickerPack', tag: 'Admin', summary: 'Rename or archive a sticker pack (Super Admin)', access: 'adminCsrf', params: idParams, body: ['UpdateStickerPackBody', media.updateStickerPackBodySchema], response: ['AdminStickerPacksResponse', media.adminStickerPacksResponseSchema] },
    { method: 'post', path: '/v1/admin/stickers/packs/{id}/stickers', operationId: 'adminAddSticker', tag: 'Admin', summary: 'Add a sticker: PNG or WebP, at most 512 KB and 512 x 512 (Super Admin)', access: 'adminCsrf', params: idParams, body: ['AddStickerBody', media.addStickerBodySchema], response: ['AdminStickerPacksResponse', media.adminStickerPacksResponseSchema] },
    { method: 'delete', path: '/v1/admin/stickers/{id}', operationId: 'adminRemoveSticker', tag: 'Admin', summary: 'Take a sticker out of its pack; messages keep showing it (Super Admin)', access: 'adminCsrf', params: idParams, response: ['AdminStickerPacksResponse', media.adminStickerPacksResponseSchema] },
    // Phase 5: groups (D-39)
    { method: 'post', path: '/v1/groups', operationId: 'createGroup', tag: 'Groups', summary: 'Create a group (system permission O-21; 10 per day)', access: 'user', body: ['CreateGroupBody', groups.createGroupBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'patch', path: '/v1/groups/{id}', operationId: 'updateGroup', tag: 'Groups', summary: 'Change the title or description', access: 'user', params: idParams, body: ['UpdateGroupBody', groups.updateGroupBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'delete', path: '/v1/groups/{id}', operationId: 'deleteGroup', tag: 'Groups', summary: 'Delete the group (owner); its history stays', access: 'user', params: idParams, response: ['OkResponse', okResponseSchema] },
    { method: 'patch', path: '/v1/groups/{id}/settings', operationId: 'updateGroupSettings', tag: 'Groups', summary: 'Member permissions and member privacy (O-04)', access: 'user', params: idParams, body: ['GroupSettingsBody', groups.groupSettingsBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'post', path: '/v1/groups/{id}/photo/upload', operationId: 'startGroupPhotoUpload', tag: 'Groups', summary: 'One-time signed upload URL for the group picture', access: 'user', params: idParams, body: ['PhotoUploadBody', me.photoUploadBodySchema], response: ['PhotoUploadResponse', me.photoUploadResponseSchema] },
    { method: 'post', path: '/v1/groups/{id}/photo/confirm', operationId: 'confirmGroupPhoto', tag: 'Groups', summary: 'Check the uploaded picture and make it the group picture', access: 'user', params: idParams, body: ['PhotoConfirmBody', me.photoConfirmBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'delete', path: '/v1/groups/{id}/photo', operationId: 'removeGroupPhoto', tag: 'Groups', summary: 'Remove the group picture', access: 'user', params: idParams, response: ['Chat', msg.chatSchema] },
    { method: 'get', path: '/v1/groups/{id}/members', operationId: 'listGroupMembers', tag: 'Groups', summary: 'Members (owner, admins, or when the list is not hidden, §7)', access: 'user', params: idParams, query: groups.groupMembersQuerySchema, response: ['GroupMembersResponse', groups.groupMembersResponseSchema] },
    { method: 'post', path: '/v1/groups/{id}/members', operationId: 'addGroupMembers', tag: 'Groups', summary: 'Add members (up to 50 at once, 500 in a group)', access: 'user', params: idParams, body: ['AddMembersBody', groups.addMembersBodySchema], response: ['AddMembersResponse', groups.addMembersResponseSchema] },
    { method: 'patch', path: '/v1/groups/{id}/members/{userId}', operationId: 'updateGroupMember', tag: 'Groups', summary: 'Promote, demote, change admin rights or restrict a member', access: 'user', params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }), body: ['UpdateMemberBody', groups.updateMemberBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'delete', path: '/v1/groups/{id}/members/{userId}', operationId: 'removeGroupMember', tag: 'Groups', summary: 'Remove a member', access: 'user', params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }), response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/groups/{id}/owner', operationId: 'transferGroupOwnership', tag: 'Groups', summary: 'Give the group to another member (owner)', access: 'user', params: idParams, body: ['TransferOwnershipBody', groups.transferOwnershipBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'post', path: '/v1/groups/{id}/leave', operationId: 'leaveGroup', tag: 'Groups', summary: 'Leave the group', access: 'user', params: idParams, response: ['OkResponse', okResponseSchema] },
    { method: 'get', path: '/v1/groups/{id}/invites', operationId: 'listInviteLinks', tag: 'Groups', summary: 'Invite links (admins who may invite)', access: 'user', params: idParams, response: ['InviteLinksResponse', groups.inviteLinksResponseSchema] },
    { method: 'post', path: '/v1/groups/{id}/invites', operationId: 'createInviteLink', tag: 'Groups', summary: 'Create an invite link', access: 'user', params: idParams, body: ['CreateInviteLinkBody', groups.createInviteLinkBodySchema], response: ['InviteLink', groups.inviteLinkSchema] },
    { method: 'delete', path: '/v1/groups/{id}/invites/{linkId}', operationId: 'revokeInviteLink', tag: 'Groups', summary: 'Revoke an invite link', access: 'user', params: z.object({ id: z.string().uuid(), linkId: z.string().uuid() }), response: ['InviteLinksResponse', groups.inviteLinksResponseSchema] },
    { method: 'get', path: '/v1/groups/{id}/requests', operationId: 'listJoinRequests', tag: 'Groups', summary: 'Pending join requests', access: 'user', params: idParams, response: ['JoinRequestsResponse', groups.joinRequestsResponseSchema] },
    { method: 'post', path: '/v1/groups/{id}/requests/{requestId}/approve', operationId: 'approveJoinRequest', tag: 'Groups', summary: 'Approve a join request', access: 'user', params: z.object({ id: z.string().uuid(), requestId: z.string().uuid() }), response: ['JoinRequestsResponse', groups.joinRequestsResponseSchema] },
    { method: 'post', path: '/v1/groups/{id}/requests/{requestId}/decline', operationId: 'declineJoinRequest', tag: 'Groups', summary: 'Decline a join request', access: 'user', params: z.object({ id: z.string().uuid(), requestId: z.string().uuid() }), response: ['JoinRequestsResponse', groups.joinRequestsResponseSchema] },
    { method: 'get', path: '/v1/invites/{code}', operationId: 'previewInvite', tag: 'Groups', summary: 'What an invite link leads to', access: 'user', params: z.object({ code: z.string() }), response: ['InvitePreview', groups.invitePreviewSchema] },
    { method: 'post', path: '/v1/invites/{code}/join', operationId: 'joinWithInvite', tag: 'Groups', summary: 'Join (or ask to join) with an invite link', access: 'user', params: z.object({ code: z.string() }), response: ['JoinResponse', groups.joinResponseSchema] },
    { method: 'post', path: '/v1/messages/{id}/poll/vote', operationId: 'votePoll', tag: 'Groups', summary: 'Vote in a poll or answer a quiz', access: 'user', params: idParams, body: ['PollVoteBody', groups.pollVoteBodySchema], response: ['Message', msg.messageSchema] },
    { method: 'delete', path: '/v1/messages/{id}/poll/vote', operationId: 'retractPollVote', tag: 'Groups', summary: 'Take a poll vote back (not for quizzes)', access: 'user', params: idParams, response: ['Message', msg.messageSchema] },
    { method: 'post', path: '/v1/messages/{id}/poll/close', operationId: 'closePoll', tag: 'Groups', summary: 'Stop a poll (its creator, or an admin who may delete messages)', access: 'user', params: idParams, response: ['Message', msg.messageSchema] },
    { method: 'get', path: '/v1/messages/{id}/poll/voters', operationId: 'listPollVoters', tag: 'Groups', summary: 'Who voted (never for anonymous polls; with a hidden member list, admins only)', access: 'user', params: idParams, response: ['PollVotersResponse', groups.pollVotersResponseSchema] },
    { method: 'get', path: '/v1/me/permissions', operationId: 'getMyPermissions', tag: 'Me', summary: 'What the signed-in user may create (O-21)', access: 'user', response: ['UserPermissions', groups.userPermissionsSchema] },
    { method: 'get', path: '/v1/admin/users/permissions', operationId: 'adminUserPermissions', tag: 'Admin', summary: "A user's system permissions (O-21)", access: 'admin', query: groups.adminUserPermissionsQuerySchema, response: ['AdminUserPermissionsResponse', groups.adminUserPermissionsResponseSchema] },
    { method: 'put', path: '/v1/admin/users/permissions', operationId: 'adminSetUserPermissions', tag: 'Admin', summary: "Change a user's system permissions (Super Admin)", access: 'adminCsrf', body: ['AdminUserPermissionsBody', groups.adminUserPermissionsBodySchema], response: ['AdminUserPermissionsResponse', groups.adminUserPermissionsResponseSchema] },
    // Phase 6: channels and scheduled messages (D-40). Groups' endpoints (/v1/groups/{id}/...) manage channels too.
    { method: 'post', path: '/v1/channels', operationId: 'createChannel', tag: 'Channels', summary: 'Create a channel (system permission O-21; 5 per day)', access: 'user', body: ['CreateChannelBody', channels.createChannelBodySchema], response: ['Chat', msg.chatSchema] },
    { method: 'get', path: '/v1/channels/search', operationId: 'searchChannels', tag: 'Channels', summary: 'Find public channels by title (O-22)', access: 'user', query: channels.channelSearchQuerySchema, response: ['ChannelSearchResponse', channels.channelSearchResponseSchema] },
    { method: 'post', path: '/v1/channels/{id}/join', operationId: 'joinChannel', tag: 'Channels', summary: 'Subscribe to a public channel', access: 'user', params: idParams, response: ['Chat', msg.chatSchema] },
    { method: 'post', path: '/v1/chats/{id}/scheduled', operationId: 'scheduleMessage', tag: 'Scheduled', summary: 'Schedule a message (channel admins who post, or system permission O-21)', access: 'user', params: idParams, body: ['ScheduleMessageBody', channels.scheduleMessageBodySchema], response: ['ScheduledMessage', channels.scheduledMessageSchema] },
    { method: 'get', path: '/v1/chats/{id}/scheduled', operationId: 'listScheduledMessages', tag: 'Scheduled', summary: "The signed-in user's scheduled messages in a chat", access: 'user', params: idParams, response: ['ScheduledMessagesResponse', channels.scheduledMessagesResponseSchema] },
    { method: 'patch', path: '/v1/scheduled/{id}', operationId: 'updateScheduledMessage', tag: 'Scheduled', summary: 'Change the time or text of a scheduled message', access: 'user', params: idParams, body: ['UpdateScheduledBody', channels.updateScheduledBodySchema], response: ['ScheduledMessage', channels.scheduledMessageSchema] },
    { method: 'delete', path: '/v1/scheduled/{id}', operationId: 'cancelScheduledMessage', tag: 'Scheduled', summary: 'Remove a scheduled message', access: 'user', params: idParams, response: ['OkResponse', okResponseSchema] },
    { method: 'post', path: '/v1/scheduled/{id}/send', operationId: 'sendScheduledMessageNow', tag: 'Scheduled', summary: 'Send a scheduled message now', access: 'user', params: idParams, response: ['Message', msg.messageSchema] },
    { method: 'post', path: '/v1/internal/dispatch', operationId: 'dispatchScheduledMessages', tag: 'Scheduled', summary: 'Send the scheduled messages that are due (the scheduled function, every minute)', access: 'dispatch', response: ['DispatchResponse', channels.dispatchResponseSchema] },
    // Phase 7: notifications (D-41)
    { method: 'get', path: '/v1/me/notification-settings', operationId: 'getNotificationSettings', tag: 'Notifications', summary: 'Which chats notify, and whether notifications show the sender and text (O-19)', access: 'user', response: ['NotificationSettings', notifications.notificationSettingsSchema] },
    { method: 'patch', path: '/v1/me/notification-settings', operationId: 'updateNotificationSettings', tag: 'Notifications', summary: 'Change notification settings', access: 'user', body: ['UpdateNotificationSettingsBody', notifications.updateNotificationSettingsBodySchema], response: ['NotificationSettings', notifications.notificationSettingsSchema] },
    { method: 'get', path: '/v1/me/badge', operationId: 'getBadge', tag: 'Notifications', summary: 'The badge count (unread messages in chats that are not muted)', access: 'user', response: ['BadgeResponse', notifications.badgeResponseSchema] },
    { method: 'post', path: '/v1/realtime/viewing', operationId: 'realtimeViewing', tag: 'Notifications', summary: 'The chat this device shows (not pushed about it)', access: 'user', body: ['ViewingBody', notifications.viewingBodySchema], response: ['OkResponse', okResponseSchema] },
    // Phase 8: global search (D-42)
    { method: 'get', path: '/v1/search', operationId: 'searchEverywhere', tag: 'Search', summary: 'Messages, files, images and voice messages in every chat the user is in', access: 'user', query: search.globalSearchQuerySchema, response: ['GlobalSearchResponse', search.globalSearchResponseSchema] },
    // Phase 10: the rest of the Admin Dashboard (D-44)
    { method: 'get', path: '/v1/admin/stats', operationId: 'adminStats', tag: 'Admin', summary: 'System statistics', access: 'admin', response: ['AdminStats', consoleApi.adminStatsSchema] },
    { method: 'get', path: '/v1/admin/users', operationId: 'adminListUsers', tag: 'Admin', summary: 'Users by phone, name or username, and status', access: 'admin', query: consoleApi.adminUsersQuerySchema, response: ['AdminUsersResponse', consoleApi.adminUsersResponseSchema] },
    { method: 'get', path: '/v1/admin/users/{id}', operationId: 'adminGetUser', tag: 'Admin', summary: 'One user: account, sessions, counts, account history', access: 'admin', params: idParams, response: ['AdminUserDetail', consoleApi.adminUserDetailSchema] },
    { method: 'post', path: '/v1/admin/users/{id}/action', operationId: 'adminUserAction', tag: 'Admin', summary: 'Suspend, reactivate, end sessions (every admin); ban, delete (Super Admin)', access: 'adminCsrf', params: idParams, body: ['AdminUserActionBody', consoleApi.adminUserActionBodySchema], response: ['AdminUserDetail', consoleApi.adminUserDetailSchema] },
    { method: 'get', path: '/v1/admin/chats', operationId: 'adminListChats', tag: 'Admin', summary: 'Groups and channels', access: 'admin', query: consoleApi.adminChatsQuerySchema, response: ['AdminChatsResponse', consoleApi.adminChatsResponseSchema] },
    { method: 'post', path: '/v1/admin/chats', operationId: 'adminCreateChat', tag: 'Admin', summary: 'Create a group or channel owned by a user (Super Admin)', access: 'adminCsrf', body: ['AdminCreateChatBody', consoleApi.adminCreateChatBodySchema], response: ['AdminChatDetail', consoleApi.adminChatDetailSchema] },
    { method: 'get', path: '/v1/admin/chats/{id}', operationId: 'adminGetChat', tag: 'Admin', summary: 'One group or channel: settings and admins (never its messages, O-18)', access: 'admin', params: idParams, response: ['AdminChatDetail', consoleApi.adminChatDetailSchema] },
    { method: 'patch', path: '/v1/admin/chats/{id}', operationId: 'adminUpdateChat', tag: 'Admin', summary: 'Edit, permissions, member privacy, public or private (Super Admin)', access: 'adminCsrf', params: idParams, body: ['AdminUpdateChatBody', consoleApi.adminUpdateChatBodySchema], response: ['AdminChatDetail', consoleApi.adminChatDetailSchema] },
    { method: 'post', path: '/v1/admin/chats/{id}/delete', operationId: 'adminDeleteChat', tag: 'Admin', summary: 'Delete a group or channel; its history stays (Super Admin)', access: 'adminCsrf', params: idParams, body: ['AdminChatReasonBody', consoleApi.adminChatReasonBodySchema], response: ['AdminChatDetail', consoleApi.adminChatDetailSchema] },
    { method: 'get', path: '/v1/admin/chats/{id}/members', operationId: 'adminListChatMembers', tag: 'Admin', summary: 'Members or subscribers', access: 'admin', params: idParams, query: consoleApi.adminChatMembersQuerySchema, response: ['AdminChatMembersResponse', consoleApi.adminChatMembersResponseSchema] },
    { method: 'post', path: '/v1/admin/chats/{id}/members', operationId: 'adminAddChatMembers', tag: 'Admin', summary: 'Add members or subscribers (Super Admin)', access: 'adminCsrf', params: idParams, body: ['AdminAddChatMembersBody', consoleApi.adminAddChatMembersBodySchema], response: ['AddMembersResponse', groups.addMembersResponseSchema] },
    { method: 'patch', path: '/v1/admin/chats/{id}/members/{userId}', operationId: 'adminUpdateChatMember', tag: 'Admin', summary: 'Make owner or admin, change rights, restrict (Super Admin)', access: 'adminCsrf', params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }), body: ['AdminUpdateChatMemberBody', consoleApi.adminUpdateChatMemberBodySchema], response: ['AdminChatMember', consoleApi.adminChatMemberSchema] },
    { method: 'post', path: '/v1/admin/chats/{id}/members/{userId}/remove', operationId: 'adminRemoveChatMember', tag: 'Admin', summary: 'Remove a member or subscriber (Super Admin)', access: 'adminCsrf', params: z.object({ id: z.string().uuid(), userId: z.string().uuid() }), body: ['AdminChatReasonBody', consoleApi.adminChatReasonBodySchema], response: ['OkResponse', okResponseSchema] },
    { method: 'get', path: '/v1/admin/reports', operationId: 'adminListReports', tag: 'Admin', summary: 'Reports, open or decided, with the reported message only (O-18)', access: 'admin', query: consoleApi.adminReportsQuerySchema, response: ['AdminReportsResponse', consoleApi.adminReportsResponseSchema] },
    { method: 'post', path: '/v1/admin/reports/{id}/decision', operationId: 'adminDecideReport', tag: 'Admin', summary: 'Dismiss, remove the message, suspend or ban (Super Admin) the reported user', access: 'adminCsrf', params: idParams, body: ['AdminDecideReportBody', consoleApi.adminDecideReportBodySchema], response: ['AdminReport', consoleApi.adminReportSchema] },
    { method: 'get', path: '/v1/admin/audit', operationId: 'adminAuditHistory', tag: 'Admin', summary: 'The permanent history for an investigation, with a reason; each view recorded (Super Admin)', access: 'admin', query: consoleApi.adminAuditQuerySchema, response: ['AdminAuditResponse', consoleApi.adminAuditResponseSchema] },
    { method: 'get', path: '/v1/admin/broadcasts', operationId: 'adminListBroadcasts', tag: 'Admin', summary: 'Broadcast notifications sent (Super Admin)', access: 'admin', response: ['AdminBroadcastsResponse', consoleApi.adminBroadcastsResponseSchema] },
    { method: 'post', path: '/v1/admin/broadcasts', operationId: 'adminSendBroadcast', tag: 'Admin', summary: 'Send a notification to everyone or one group or channel (O-20, Super Admin)', access: 'adminCsrf', body: ['AdminBroadcastBody', consoleApi.adminBroadcastBodySchema], response: ['AdminBroadcast', consoleApi.adminBroadcastSchema] },
    { method: 'get', path: '/v1/admin/settings/access', operationId: 'adminAccessSettings', tag: 'Admin', summary: 'Who can create an account (D-47)', access: 'admin', response: ['AdminAccessSettings', consoleApi.adminAccessSettingsSchema] },
    { method: 'put', path: '/v1/admin/settings/access', operationId: 'adminSetAccessSettings', tag: 'Admin', summary: 'Anyone with WhatsApp, or academy list only (D-47, Super Admin)', access: 'adminCsrf', body: ['AdminAccessSettingsBody', consoleApi.adminAccessSettingsBodySchema], response: ['AdminAccessSettings', consoleApi.adminAccessSettingsSchema] },
    { method: 'get', path: '/v1/admin/settings/gifs', operationId: 'adminGifSettings', tag: 'Admin', summary: 'Whether a GIPHY key is set (never returned)', access: 'admin', response: ['GifSettingsResponse', media.gifSettingsResponseSchema] },
    { method: 'put', path: '/v1/admin/settings/gifs', operationId: 'adminSetGifKey', tag: 'Admin', summary: 'Set or remove the GIPHY key (Super Admin)', access: 'adminCsrf', body: ['GifSettingsBody', media.gifSettingsBodySchema], response: ['GifSettingsResponse', media.gifSettingsResponseSchema] },
  ];

  for (const route of routes) {
    const security = SECURITY[route.access];
    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      tags: [route.tag],
      summary: route.summary,
      ...(security ? { security } : {}),
      request: {
        ...(route.params ? { params: forOpenApi(route.params) } : {}),
        ...(route.query ? { query: forOpenApi(route.query) } : {}),
        ...(route.body ? { body: { required: true, content: { 'application/json': { schema: named(...route.body) } } } } : {}),
      },
      responses: {
        200: Array.isArray(route.response)
          ? { description: 'Success.', content: { 'application/json': { schema: named(...route.response) } } }
          : { description: 'Success.', content: { [route.response.binary]: { schema: { type: 'string', format: 'binary' } } } },
        '4XX': { description: 'Rejected request (see error.code).', content: { 'application/json': { schema: errorEnvelope } } },
        '5XX': { description: 'Unexpected error or a dependency is unavailable.', content: { 'application/json': { schema: errorEnvelope } } },
      },
    });
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Bedo Chat API', version: options.version },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
  });
}
