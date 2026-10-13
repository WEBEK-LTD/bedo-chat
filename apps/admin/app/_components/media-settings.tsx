'use client';

import {
  adminAddSticker,
  adminCreateStickerPack,
  adminGifSettings,
  adminListStickers,
  adminRemoveSticker,
  adminSetGifKey,
  adminStickerImage,
  adminUpdateStickerPack,
  type AdminStickerPacksResponse,
  type GifSettingsResponse,
} from '@bedo/api-client';
import { MEDIA_RULES } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { StarterStickers } from './starter-stickers';
import { Button, FormError, Notice, TextField } from './ui';

type Pack = AdminStickerPacksResponse['packs'][number];

/** A pack shows this many stickers until it is opened, so a page of big packs loads quickly. */
const PREVIEW_COUNT = 12;

/** A sticker image as a data URL: the dashboard's security policy shows pictures only from itself or data URLs. */
function StickerImage({ id, emoji }: { id: string; emoji: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    adminStickerImage(id)
      .then((image) => !cancelled && setSrc(`data:${image.mimeType};base64,${image.data}`))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);
  return src ? <img src={src} alt={`Sticker ${emoji}`} className="size-20 object-contain" /> : <span className="grid size-20 place-items-center text-3xl">{emoji}</span>;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

/**
 * Stickers (O-10) and GIFs (O-09), Phase 4. Every admin sees the packs and whether GIF search is on; Super Admins
 * create packs, add PNG or WebP stickers (at most 512 KB and 512 x 512), take stickers out, archive packs, and set
 * the GIPHY key (stored encrypted, never shown again).
 */
export function MediaSettings({ canChange, onSessionError }: { canChange: boolean; onSessionError: (error: unknown) => void }) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [gifs, setGifs] = useState<GifSettingsResponse | null>(null);
  const [name, setName] = useState('');
  const [giphyKey, setGiphyKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ packId: string; emoji: string; file: File | null } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const fail = useCallback(
    (caught: unknown) => {
      onSessionError(caught);
      setError(errorMessage(caught));
    },
    [onSessionError],
  );

  useEffect(() => {
    adminListStickers()
      .then((response) => setPacks(response.packs))
      .catch(fail);
    adminGifSettings().then(setGifs).catch(fail);
  }, [fail]);

  async function run(action: () => Promise<AdminStickerPacksResponse | void>, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await action();
      if (response) setPacks(response.packs);
      setDone(message);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  async function createPack(event: FormEvent) {
    event.preventDefault();
    await run(() => adminCreateStickerPack({ name: name.trim() }), 'Sticker pack created.');
    setName('');
  }

  async function addSticker(event: FormEvent) {
    event.preventDefault();
    if (!adding?.file) return;
    if (adding.file.size > MEDIA_RULES.stickerMaxBytes) {
      setError('The image is larger than 512 KB.');
      return;
    }
    const data = await readBase64(adding.file);
    await run(() => adminAddSticker(adding.packId, { emoji: adding.emoji.trim() || '🙂', data }), 'Sticker added.');
    setAdding(null);
  }

  /** Saves a new key (GIPHY checks it first), or with `remove` turns GIF search off. */
  async function saveGifKey(event: FormEvent | null, remove = false) {
    event?.preventDefault();
    const apiKey = remove ? '' : giphyKey.trim();
    if (!remove && !apiKey) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setGifs(await adminSetGifKey({ apiKey }));
      setDone(apiKey ? 'GIPHY accepted the key and it is saved. GIF search is on for everyone.' : 'The GIPHY key is removed. GIF search is off.');
      setGiphyKey('');
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Stickers and GIFs</h1>
      <FormError message={error} />
      {done ? <Notice>{done}</Notice> : null}

      <section aria-labelledby="gif-title" className="flex flex-col gap-3">
        <h2 id="gif-title" className="font-semibold">
          GIF search (GIPHY)
        </h2>
        <p className="text-sm text-ink-secondary">
          Students search GIFs through Bedo Chat; GIPHY never sees their addresses. A sent GIF is copied into Bedo Chat&apos;s storage, so it keeps
          working if GIPHY removes it.
        </p>
        {gifs ? (
          <div
            className={`flex items-start gap-3 rounded-md border p-3.5 text-sm ${gifs.configured ? 'border-success/30 bg-success/10' : 'border-line bg-surface'}`}
            data-testid="gif-key-status"
          >
            <Icon name={gifs.configured ? 'check_circle' : 'info'} size={20} className={`shrink-0 ${gifs.configured ? 'text-success' : 'text-ink-secondary'}`} />
            <span>
              <span className="font-semibold">{gifs.configured ? 'GIF search is on.' : 'GIF search is off.'}</span>{' '}
              {gifs.configured ? 'A GIPHY key is saved. For safety it is never shown again, so the box below stays empty.' : 'No GIPHY key is saved.'}
              {gifs.updatedAt ? ` Last changed ${formatDateTime(gifs.updatedAt)}${gifs.updatedBy ? ` by ${gifs.updatedBy.name}` : ''}.` : ''}
            </span>
          </div>
        ) : null}
        {canChange ? (
          <form className="flex flex-col gap-3" onSubmit={(event) => void saveGifKey(event)}>
            <TextField
              id="giphy-key"
              label={gifs?.configured ? 'Replace the GIPHY API key' : 'GIPHY API key'}
              value={giphyKey}
              autoComplete="off"
              placeholder={gifs?.configured ? 'Saved key hidden. Paste a new key only to replace it.' : 'Paste the API key from developers.giphy.com'}
              onChange={(event) => setGiphyKey(event.target.value)}
              hint="GIPHY checks the key before it is saved."
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !giphyKey.trim()}>
                Save key
              </Button>
              {gifs?.configured ? (
                <Button variant="danger" disabled={busy} onClick={() => void saveGifKey(null, true)}>
                  Turn GIF search off
                </Button>
              ) : null}
            </div>
          </form>
        ) : null}
      </section>

      <section aria-labelledby="stickers-title" className="flex flex-col gap-4">
        <h2 id="stickers-title" className="font-semibold">
          Sticker packs
        </h2>
        {canChange ? (
          <form className="flex items-end gap-2" onSubmit={(event) => void createPack(event)}>
            <div className="flex-1">
              <TextField id="pack-name" label="New pack name" value={name} maxLength={MEDIA_RULES.stickerPackNameMaxLength} onChange={(event) => setName(event.target.value)} />
            </div>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create pack
            </Button>
          </form>
        ) : null}
        {canChange && packs ? <StarterStickers packs={packs} onPacks={setPacks} onError={fail} disabled={busy} /> : null}
        {packs === null ? <p className="text-sm text-ink-secondary">Loading…</p> : null}
        {packs?.length === 0 ? <p className="text-sm text-ink-secondary">No sticker packs yet.</p> : null}
        {packs?.map((pack) => (
          <article key={pack.id} className="flex flex-col gap-3 rounded-md border border-line bg-surface shadow-sm p-4" aria-label={`Pack ${pack.name}`}>
            <header className="flex items-center gap-2">
              <h3 className="flex-1 font-medium">
                {pack.name}
                {pack.archived ? <span className="ml-2 text-xs text-ink-secondary">(archived: not offered)</span> : null}
              </h3>
              {canChange ? (
                <>
                  <Button variant="secondary" disabled={busy} onClick={() => setAdding({ packId: pack.id, emoji: '', file: null })}>
                    Add sticker
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => adminUpdateStickerPack(pack.id, { archived: !pack.archived }), pack.archived ? 'Pack restored.' : 'Pack archived.')}
                  >
                    {pack.archived ? 'Restore' : 'Archive'}
                  </Button>
                </>
              ) : null}
            </header>
            {adding?.packId === pack.id ? (
              <form className="flex flex-wrap items-end gap-3 rounded-sm bg-surface-subtle p-3" onSubmit={(event) => void addSticker(event)}>
                <label className="flex flex-col gap-1 text-sm">
                  Image (PNG or WebP, at most 512 KB and 512 x 512)
                  <input type="file" accept="image/png,image/webp" onChange={(event) => setAdding({ ...adding, file: event.target.files?.[0] ?? null })} />
                </label>
                <div className="w-28">
                  <TextField id="sticker-emoji" label="Emoji" value={adding.emoji} maxLength={16} onChange={(event) => setAdding({ ...adding, emoji: event.target.value })} />
                </div>
                <Button type="submit" disabled={busy || !adding.file}>
                  Upload
                </Button>
                <Button variant="secondary" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
            <ul className="flex flex-wrap gap-3">
              {pack.stickers.filter((sticker) => !sticker.removed).length === 0 ? <li className="text-sm text-ink-secondary">No stickers in this pack.</li> : null}
              {pack.stickers
                .filter((sticker) => !sticker.removed)
                .slice(0, expanded.has(pack.id) ? undefined : PREVIEW_COUNT)
                .map((sticker) => (
                  <li key={sticker.id} className="relative flex flex-col items-center gap-1 rounded-sm border border-line bg-surface p-2">
                    <StickerImage id={sticker.id} emoji={sticker.emoji} />
                    <span className="text-xs text-ink-secondary">
                      {sticker.emoji} · {sticker.width}×{sticker.height}
                    </span>
                    {canChange ? (
                      <button
                        type="button"
                        aria-label={`Take sticker ${sticker.emoji} out of the pack`}
                        disabled={busy}
                        onClick={() => void run(() => adminRemoveSticker(sticker.id), 'Sticker taken out of the pack. Messages that carry it keep showing it.')}
                        className="absolute right-1 top-1 grid size-7 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
                      >
                        <Icon name="delete" size={18} />
                      </button>
                    ) : null}
                  </li>
                ))}
            </ul>
            {pack.stickers.filter((sticker) => !sticker.removed).length > PREVIEW_COUNT ? (
              <div>
                <Button
                  variant="ghost"
                  className="h-9 px-3"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(pack.id)) next.delete(pack.id);
                      else next.add(pack.id);
                      return next;
                    })
                  }
                >
                  {expanded.has(pack.id) ? 'Show fewer' : `Show all ${pack.stickers.filter((sticker) => !sticker.removed).length} stickers`}
                </Button>
              </div>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  );
}
