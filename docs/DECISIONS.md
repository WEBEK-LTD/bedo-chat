# Bedo Chat — Decision log

This file mirrors the approved decisions in the *Bedo Chat — Phase 0 Blueprint*. The blueprint is the
source of truth; if the two ever differ, the blueprint wins and this file is corrected.

## Approved decisions

| ID | Decision | Choice | Approved |
| --- | --- | --- | --- |
| D-01 | Approach | Phase 0 blueprint first, then a phased build, each phase gated by owner approval | 2026-10-04 |
| D-02 | Stack | Next.js/React/TypeScript/Tailwind user web app + separate Next.js admin app; NestJS modular-monolith API + separate NestJS worker; Supabase Postgres (source of truth) and Storage; Redis + BullMQ; Kysely; pnpm + Turborepo | 2026-10-04 |
| D-03 | Client platforms | Web app + native mobile apps (iOS, Android) + desktop app, one account with synchronised sessions | 2026-10-04 |
| D-04 | Interface language | English only, left-to-right | 2026-10-04 |
| D-05 | OTP delivery | Waabek.com `POST /api/v1/send`, called only from the backend; the API key lives only in server environment variables | 2026-10-04 |
| D-06 (O-01) | Academy-only access | Admin-loaded phone list. Only numbers added or imported by an authorised system admin can create or activate an account. No public sign-up and no open registration. The admin capability to add and import academy users is approved | 2026-10-04 |
| D-07 (O-05) | Realtime transport | NestJS WebSocket gateway + Redis. Every realtime event passes the same permission checks as HTTP. Supabase Realtime is not used for application messaging | 2026-10-04 |
| D-08 (O-06) | Authentication | Custom authentication and sessions in NestJS: OTP through Waabek, device and session management, rotating refresh tokens, 2-Step Verification. Supabase Auth is never exposed to clients | 2026-10-04 |
| D-09 (O-13) | Design scale | 25,000 registered users; 5,000 peak concurrent; long-term message retention with no age-based deletion; must scale beyond without a rewrite | 2026-10-04 |
| D-10 (O-25) | Infrastructure | Supabase Postgres + Storage; Supabase region closest to the academy's users; managed Redis; production-grade managed hosting for API and worker; separate domains for user app and admin; everything configurable through environment variables; exact provider, region, plan and domains confirmed with the owner before production | 2026-10-04 |
| D-11 (O-29) | Delivery | One ZIP of the complete verified project at the end of every completed phase (project, docs, `.env.example` files, migrations, tests, build instructions). No GitHub delivery without explicit approval | 2026-10-04 |
| D-12 (O-14) | Forgotten 2-Step password | Reset by an authorised system admin after an identity check; the user contacts the academy administration. No email recovery unless approved later | 2026-10-04 |
| D-13 (O-15) | Login alerts | New device or session: in-app security notice, push to the user's other active sessions, login recorded in the audit history. Never WhatsApp/Waabek | 2026-10-04 |
| D-14 (O-16, amended) | Account deletion requires admin approval | Request → "Deletion Requested" → recorded in audit → admin review → approve or reject → user informed → request and decision permanently recorded. On approval: messages stay and show "Deleted account" to normal users; original identity stays available to authorised admins; audit records, retained content and moderation history are never deleted; sessions revoked; status and event permanently recorded. Dedicated admin area for pending requests. No automatic deletion on a timer. Changes spec §2 "Delete account" (owner-approved) | 2026-10-04 |
| D-15 | Hosting targets | Web app and Admin Dashboard deployable to Netlify. Supabase Postgres (source of truth) and Supabase Storage (private files). API, WebSocket gateway and worker on persistent backend infrastructure, not Netlify functions. Managed Redis for BullMQ. Refines D-10 | 2026-10-04 |
| D-16 | Delivery and test gate | Every phase delivered as a ZIP ready for immediate testing and deployment; the owner tests each phase before the next starts. Extends D-11 | 2026-10-04 |
| D-17 | Permanent audit and activity history | Designed in from the start. Retains activity when students delete or edit messages, change name, username or profile, leave groups or change other relevant information. Authorised admins can review deleted and edited content and historical identity and activity. Normal users can never modify or delete it | 2026-10-04 |
| D-18 | Screenshot events | Recorded in the audit history where the platform supports detection (user, time, platform and device, conversation, screen or message context, message ID when reliable) and shown to authorised admins. Detection is never claimed where the OS or browser does not expose it | 2026-10-04 |
| D-19 (O-17) | System admin accounts | Separate from student accounts; phone code plus mandatory authenticator app; roles Super Admin and Moderator; first Super Admin created from the command line | 2026-10-04 |
| D-20 (O-32) | Admin screens in Phase 2 | Admin sign-in plus the academy phone list, deletion requests and 2-Step reset screens are built in Phase 2; the rest of the dashboard in Phase 10 | 2026-10-04 |
| D-21 (O-31) | Push for login alerts in Phase 2 | Push pipeline built in Phase 2 with Web Push delivery to web sessions; APNs and FCM join the same pipeline in Phase 12; Phase 7 adds message notifications on top | 2026-10-04 |
| R-01 | Standing rules | No feature outside the approved specification. No AI features, AI branding, AI artwork, AI-generated icons or illustrations. Google Material Symbols only. User app limited to Login → Chat Interface. Admin Dashboard separate. Phase work starts only after its decisions are recorded | 2026-10-04 |

## Phase 1 implementation choices

These are technical choices inside the approved stack. None changes requested behaviour.

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 24, pnpm 10.28, TypeScript 6.0.3 (strict), ES modules throughout | Matches the approved baseline; NestJS 12 is ES-module native |
| Tooling carried from the baseline | Fastify adapter; Zod 4 + zod-to-openapi; install scripts blocked; 14-day minimum release age | Approved baseline |
| Migrations | Own checksummed runner applying `supabase/migrations` | Works on any Postgres including Supabase, with no provider hard-coded (D-10) |
| Response contracts | Every API route must declare a Zod response schema; unknown fields are stripped, routes without a schema fail closed | Foundation for server-enforced member privacy (spec §7) |
| Icons | Material Symbols Outlined 400, inlined as SVG paths generated from the official `@material-symbols/svg-400` package | Spec §26; avoids shipping a multi-megabyte icon font |
| Database roles | Migrations run as the table owner; the API and worker connect as a member of `bedo_runtime`, which gets explicit per-table grants only | The application cannot alter tables or disable triggers, so the append-only audit log holds |
| Proxy trust | `API_TRUST_PROXY_HOPS` (default 0): client IP and incoming request ids are trusted only through the configured number of proxies | Correct client IPs for rate limiting (Phase 2) without letting clients spoof them |
| Queue keys | `QUEUE_PREFIX` (default `bedo`) on every BullMQ queue | Environments can share one Redis without touching each other's queues |
| Typed API client (orval) | Starts in Phase 2 | Phase 1 has no callable product endpoints yet |

## Security exceptions (temporary)

| Package | Exception | Reason | Remove after |
| --- | --- | --- | --- |
| `next`, `@next/*` | Exempt from the 14-day release-age rule; pinned exactly to 16.3.6 | 16.2.0–16.3.5 have a critical advisory (remote code execution in `next/og` ImageResponse). 16.3.6 is the first patched release, published 2026-09-22 | 2026-10-06 — then remove the exemption and return to a caret range |
| `fastify` | Override to `^5.12.5` | `@nestjs/platform-fastify` 12.0.3 pins 5.12.4, which has a moderate denial-of-service advisory | When the Nest adapter depends on ≥ 5.12.5 |

## Open decisions

21 decisions remain open in the blueprint; none blocks Phase 2. The next ones are needed for Phase 3:
O-23 (brand), O-27 (edit and delete time limits) and O-28 (platform build order).
