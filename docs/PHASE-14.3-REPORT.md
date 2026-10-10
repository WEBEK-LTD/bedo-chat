# Phase 14.3 report — starter sticker packs

Built on Phase 14.2 (branch `phase-14-3-stickers`). The owner asked for many stickers.

## What changed

- **578 ready-made stickers in six packs:** Faces (89), Hearts and hands (65), Animals (120), Food and drink (119),
  Study (98) and Celebrate (87). They are the 3D Fluent Emoji by Microsoft (MIT License), converted to WebP at
  256 x 256 (4 MB in all), shipped with the Admin Dashboard in `apps/admin/public/starter-stickers` with a
  `manifest.json` (pack, file, emoji). Chosen for an academy: no alcohol, pork, smoking, rude gestures or scary faces.
- **Admin Dashboard → Stickers and GIFs → "Add starter stickers"** (Super Admins). It creates the packs and uploads
  every sticker through the normal sticker upload, so each one is checked and stored like a sticker added by hand.
  Three packs fill at once, with a progress bar. Pressing it again continues where it stopped: a pack with the same
  name is reused and only its missing stickers are added; nothing is added twice.
- Each pack in the dashboard shows 12 stickers until "Show all" is pressed, so the page stays quick with big packs.
- Students' sticker picker: a strip at the top with one button per pack jumps to that pack.
- Licence notice in `packages/ui/THIRD_PARTY_NOTICES.md`; the MIT text is next to the images.

## Checks

- New `packages/e2e/test/starter-stickers.e2e.test.ts`: all six packs with the right counts after one press, a
  second press adds nothing, packs show 12 until opened, a student sees every pack in the picker and sends a sticker
  that arrives as a 256 x 256 picture; no Content-Security-Policy violation.
- Typecheck, lint, unit, integration and all browser tests pass.

## For the owner

Upload the repository with GitHub Desktop. Then in the Admin Dashboard: Stickers and GIFs → Add starter stickers,
and keep the page open until it says all are in (a few minutes once the site runs in Sydney; much longer while it
runs in the US). No SQL and no Netlify change.
