# Phase 14 report — the new look (D-48)

Built on Phase 13.4 (branch `phase-14-design`). Decision: **D-48** in `docs/DECISIONS.md` (it amends O-23/D-29 for
colours, type and shape). The owner asked for the whole site to look very advanced: a Telegram-like look but more
polished, light and dark that follow the device with a switch, the student app and the Admin Dashboard, and the
current blue kept. Nothing about data, the API, permissions or security changed; there is no database update.

## What changed for people

- **Light and dark.** Both apps follow the phone's or computer's setting. Students can pick in Settings →
  Appearance (Same as this device, Light, Dark); the choice is kept on that browser and the page is drawn in that
  theme from the first moment (no white flash). Admins have a theme button in the dashboard's header (device → light
  → dark), kept in that browser.
- **Chats.** A soft dotted wallpaper behind the messages; rounder bubbles with a small tail corner on the sender's
  side (outgoing in Bedo blue, incoming white or dark grey); the day ("Today") as a floating label that stays at the
  top while scrolling; replies as a tinted block with a blue bar; a glass header and pinned-message bar; a rounded
  message box with round send and record buttons. On phones the per-message actions button is quieter.
- **Chat list.** Rounded rows; the open chat highlighted in light blue; bolder names; unread counts in blue (grey
  when the chat is muted) and the time in blue when there is something unread; folders as pill tabs; a rounded
  search box.
- **Avatars** without a picture have one of seven gradient colours, picked from the name, the same on every device.
- **Settings** opens with a larger profile header and coloured icon tiles for each section.
- **Sign-in** is a card on the wallpaper with the app icon above it.
- **Admin Dashboard.** Glass header with the app mark; the current section highlighted in blue; content on light
  grey with white cards; overview numbers larger with icon tiles; pill tabs; inputs with a focus ring; a sign-in
  card. Its sections menu stays in place while the page scrolls on a computer.
- **Type.** Figtree, a modern open-source typeface, served from the site itself (no outside font service; SIL Open
  Font License, in `packages/ui/THIRD_PARTY_NOTICES.md`). Arabic and other scripts use the device's own font.

## Where it lives

- `packages/ui/src/tokens.css`: every colour for light and dark, the font, corners, shadows, glass, avatar tones and
  the open animations (switched off for people who ask for reduced motion).
- `apps/web/app/_lib/theme.ts`, `settings/appearance-panel.tsx`, `layout.tsx` (reads the `bedo_theme` cookie and
  writes `data-theme` into the page).
- `apps/admin/app/_lib/theme.ts`, `_components/theme-init.tsx`, the theme button in `dashboard.tsx`.
- `apps/web/public/fonts/` (two font files and the licence); the site's request handler skips them like icons.

## Checks

- New browser test `packages/e2e/test/design.e2e.test.ts` (10 tests): light and dark from the device on a computer
  and a phone for sign-in, the chat list, a chat, settings and appearance; the Admin Dashboard's sign-in, overview,
  menu and users in both themes and sizes; the student's choice kept across a reload and already in the page the
  server sends; the admin's theme button and its choice kept across a reload; Figtree loaded; no
  Content-Security-Policy violation. `E2E_SCREENSHOTS=<folder>` saves all 34 screens.
- Typecheck, lint, unit, integration and all browser tests pass; owner SQL unchanged.

## For the owner

Upload the repository with GitHub Desktop as usual; Netlify rebuilds the site. No SQL to run and no Netlify setting
to change.
