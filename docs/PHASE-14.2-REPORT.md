# Phase 14.2 report — GIFs work with a real GIPHY key

Built on Phase 14.1 (branch `phase-14-2-gifs`). A fix, no new decision.

## What was wrong

- **"No GIFs found" for every search.** For searches the API asks GIPHY for its messaging set of image sizes
  (`bundle=messaging_non_clips`, smaller answers). That set has no still frames, and the API required one, so it
  dropped every GIF GIPHY returned. The tests' GIPHY stand-in always sent still frames, so they did not show it.
- **The key seemed to disappear.** The saved key is never shown again (it is stored encrypted), so after a refresh
  the box is empty. Saving with the box empty removed the key and turned GIF search off.

## What changed

- The still frame is optional; search results come through with the messaging set.
- Admin Dashboard → Stickers and GIFs:
  - A clear status: "GIF search is on" (green) or "off", with when and by whom it last changed, and why the box
    stays empty.
  - "Save key" works only with a key typed in; turning GIF search off is its own button.
  - GIPHY checks the key before it is saved. A key GIPHY refuses is not saved and the admin sees why
    (`GIPHY_KEY_INVALID`); if GIPHY cannot be reached nothing is saved.
- Stickers need no key: a Super Admin uploads packs in the same section.

## Checks

- New `apps/api/test/giphy-provider.test.ts`: a search answer shaped like GIPHY's messaging set gives results;
  results without an MP4 or from another host are still dropped; GIPHY's refusal status is reported.
- `media.integration.test.ts`: a refused key and an unreachable GIPHY save nothing; a good key stays saved on the
  next read.
- The browser tests' GIPHY stand-in now answers searches like GIPHY (no still frames), and the GIF search and send
  test passes with it.
- Typecheck, lint, unit, integration and all browser tests pass.

## For the owner

No SQL and no Netlify change. After uploading: open Stickers and GIFs, paste the GIPHY key once more and press
Save key (if it was removed by an empty save, the status shows "GIF search is off").
