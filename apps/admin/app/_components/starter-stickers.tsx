'use client';

import { adminAddSticker, adminCreateStickerPack, adminListStickers, type AdminStickerPacksResponse } from '@bedo/api-client';
import { useState } from 'react';
import { Button } from './ui';

type Pack = AdminStickerPacksResponse['packs'][number];

/** Served with the dashboard (apps/admin/public/starter-stickers): Fluent Emoji 3D by Microsoft, MIT License. */
const BASE = '/admin/starter-stickers';

interface Manifest {
  packs: Array<{ name: string; stickers: Array<{ file: string; emoji: string }> }>;
}

async function fileAsBase64(path: string): Promise<string> {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) throw new Error(`The sticker ${path} could not be loaded`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * Phase 14.3: ready-made sticker packs a Super Admin adds with one button, through the same API as a single upload
 * (each sticker checked and stored like any other). Running it again continues where it stopped: a pack with the
 * same name is reused and only its missing stickers are added.
 */
export function StarterStickers({
  packs,
  onPacks,
  onError,
  disabled,
}: {
  packs: Pack[];
  onPacks: (packs: Pack[]) => void;
  onError: (caught: unknown) => void;
  disabled: boolean;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [finished, setFinished] = useState(false);

  async function addAll() {
    setFinished(false);
    try {
      const response = await fetch(`${BASE}/manifest.json`);
      if (!response.ok) throw new Error('The starter stickers could not be loaded');
      const manifest = (await response.json()) as Manifest;
      let latest = packs;
      const total = manifest.packs.reduce((sum, pack) => sum + pack.stickers.length, 0);
      let done = 0;
      const working = new Set<string>();
      const report = () => setProgress({ done, total, current: [...working].join(', ') });
      report();
      // The packs first (one at a time, so each name is created once), then three packs fill at the same time; the
      // stickers of one pack go in order.
      const targets: Array<{ packId: string; already: number; stickers: Manifest['packs'][number]['stickers']; name: string }> = [];
      for (const wanted of manifest.packs) {
        let pack = latest.find((item) => item.name === wanted.name && !item.archived);
        if (!pack) {
          latest = (await adminCreateStickerPack({ name: wanted.name })).packs;
          pack = latest.find((item) => item.name === wanted.name && !item.archived);
          if (!pack) throw new Error(`The pack ${wanted.name} could not be created`);
        }
        const already = Math.min(pack.stickers.filter((sticker) => !sticker.removed).length, wanted.stickers.length);
        done += already;
        targets.push({ packId: pack.id, already, stickers: wanted.stickers, name: wanted.name });
      }
      onPacks(latest);
      report();
      const queue = [...targets];
      const worker = async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          working.add(target.name);
          report();
          for (const sticker of target.stickers.slice(target.already)) {
            await adminAddSticker(target.packId, { emoji: sticker.emoji, data: await fileAsBase64(sticker.file) });
            done += 1;
            report();
          }
          working.delete(target.name);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      onPacks((await adminListStickers()).packs);
      setFinished(true);
    } catch (caught) {
      onError(caught);
      onPacks((await adminListStickers().catch(() => ({ packs }))).packs);
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent/20 bg-accent-soft/50 p-4">
      <div>
        <p className="font-semibold">Starter sticker packs</p>
        <p className="text-sm text-ink-secondary">
          578 stickers in six packs: Faces, Hearts and hands, Animals, Food and drink, Study, and Celebrate. From Fluent Emoji by Microsoft (MIT
          License). If it stops, press the button again to continue.
        </p>
      </div>
      {progress ? (
        <div className="flex flex-col gap-1.5" role="status">
          <p className="text-sm">
            Adding {progress.current}… {progress.done} of {progress.total}. Keep this page open.
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-surface">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={disabled} onClick={() => void addAll()}>
            Add starter stickers
          </Button>
          {finished ? (
            <span className="text-sm text-success" role="status">
              All starter stickers are in. Students see them now.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
