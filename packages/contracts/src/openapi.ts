import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as admin from './admin.js';
import * as auth from './auth.js';
import { CSRF_HEADER, errorEnvelopeSchema, okResponseSchema } from './common.js';
import { liveResponseSchema, readyResponseSchema } from './health.js';
import * as me from './me.js';

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
        description: 'Postgres and Redis are reachable.',
        content: { 'application/json': { schema: readyResponse } },
      },
      503: {
        description: 'At least one dependency is unreachable.',
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

  type Access = 'public' | 'publicCsrf' | 'user' | 'refresh' | 'admin' | 'adminCsrf';
  const SECURITY: Record<Access, Array<Record<string, string[]>> | undefined> = {
    public: undefined,
    publicCsrf: [{ csrfHeader: [] }],
    user: [{ bearerAuth: [] }],
    refresh: [{ refreshCookie: [], csrfHeader: [] }],
    admin: [{ adminSession: [] }],
    adminCsrf: [{ adminSession: [], csrfHeader: [] }],
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
    response: [string, z.ZodType];
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
    { method: 'post', path: '/v1/admin/auth/otp/request', operationId: 'adminRequestCode', tag: 'Admin', summary: 'Send an admin sign-in code', access: 'publicCsrf', body: ['AdminOtpRequestBody', admin.adminOtpRequestBodySchema], response: ['OtpRequestResponse', auth.otpRequestResponseSchema] },
    { method: 'post', path: '/v1/admin/auth/otp/verify', operationId: 'adminVerifyCode', tag: 'Admin', summary: 'Verify the admin phone code', access: 'publicCsrf', body: ['AdminOtpVerifyBody', admin.adminOtpVerifyBodySchema], response: ['AdminOtpVerifyResponse', admin.adminOtpVerifyResponseSchema] },
    { method: 'post', path: '/v1/admin/auth/totp/verify', operationId: 'adminVerifyTotp', tag: 'Admin', summary: 'Verify the authenticator-app code and start the admin session', access: 'publicCsrf', body: ['AdminTotpVerifyBody', admin.adminTotpVerifyBodySchema], response: ['AdminSessionResponse', admin.adminSessionResponseSchema] },
    { method: 'get', path: '/v1/admin/session', operationId: 'adminSession', tag: 'Admin', summary: 'Current admin', access: 'admin', response: ['AdminSessionResponse', admin.adminSessionResponseSchema] },
    { method: 'post', path: '/v1/admin/session/logout', operationId: 'adminLogout', tag: 'Admin', summary: 'End the admin session', access: 'adminCsrf', response: ['OkResponse', okResponseSchema] },
    // Admin areas (D-20)
    { method: 'get', path: '/v1/admin/phone-list', operationId: 'adminListPhones', tag: 'Admin', summary: 'Academy phone list', access: 'admin', query: admin.phoneListQuerySchema, response: ['PhoneListResponse', admin.phoneListResponseSchema] },
    { method: 'post', path: '/v1/admin/phone-list', operationId: 'adminAddPhone', tag: 'Admin', summary: 'Add a number (Super Admin)', access: 'adminCsrf', body: ['PhoneListAddBody', admin.phoneListAddBodySchema], response: ['PhoneListAddResponse', admin.phoneListAddResponseSchema] },
    { method: 'post', path: '/v1/admin/phone-list/import', operationId: 'adminImportPhones', tag: 'Admin', summary: 'Import numbers from CSV (Super Admin)', access: 'adminCsrf', body: ['PhoneListImportBody', admin.phoneListImportBodySchema], response: ['PhoneListImportResponse', admin.phoneListImportResponseSchema] },
    { method: 'get', path: '/v1/admin/deletion-requests', operationId: 'adminListDeletionRequests', tag: 'Admin', summary: 'Account deletion requests', access: 'admin', query: admin.deletionRequestListQuerySchema, response: ['DeletionRequestListResponse', admin.deletionRequestListResponseSchema] },
    { method: 'get', path: '/v1/admin/deletion-requests/{id}', operationId: 'adminDeletionRequest', tag: 'Admin', summary: 'One request with account activity and history', access: 'admin', params: idParams, response: ['DeletionRequestDetail', admin.deletionRequestDetailSchema] },
    { method: 'post', path: '/v1/admin/deletion-requests/{id}/approve', operationId: 'adminApproveDeletion', tag: 'Admin', summary: 'Approve and delete the account (Super Admin)', access: 'adminCsrf', params: idParams, body: ['DeletionDecisionBody', admin.deletionDecisionBodySchema], response: ['DeletionRequestDetail', admin.deletionRequestDetailSchema] },
    { method: 'post', path: '/v1/admin/deletion-requests/{id}/reject', operationId: 'adminRejectDeletion', tag: 'Admin', summary: 'Reject the request (Super Admin)', access: 'adminCsrf', params: idParams, body: ['DeletionDecisionBody', admin.deletionDecisionBodySchema], response: ['DeletionRequestDetail', admin.deletionRequestDetailSchema] },
    { method: 'post', path: '/v1/admin/users/two-step-reset', operationId: 'adminResetTwoStep', tag: 'Admin', summary: 'Reset a user\'s 2-Step password after an identity check (Super Admin)', access: 'adminCsrf', body: ['TwoStepResetBody', admin.twoStepResetBodySchema], response: ['TwoStepResetResponse', admin.twoStepResetResponseSchema] },
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
        200: { description: 'Success.', content: { 'application/json': { schema: named(...route.response) } } },
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
