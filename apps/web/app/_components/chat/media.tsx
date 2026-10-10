'use client';

import { type Attachment, type Gif, type MediaFilter, type Message, REACTION_EMOJIS, type Reaction, type Sticker, type StickerPack } from '@bedo/contracts';
import { Icon, type IconName } from '@bedo/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessagingStore } from '../../_lib/messaging/context';
import { formatBytes, formatDuration, MEDIA_LABEL } from '../../_lib/messaging/media';
import type { PendingUpload } from '../../_lib/messaging/store';
import { Dialog } from './menu';

/** A file link fetched when needed (links last 5 minutes, so they are fetched again after 4). */
function useFileUrl(messageId: string, enabled: boolean): string | null {
  const store = useMessagingStore();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      store
        .fileUrl(messageId)
        .then((value) => !cancelled && setUrl(value))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 4 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [messageId, enabled, store]);
  return url;
}

/** Saves a message's file: the link makes the browser download it under its name. */
async function download(store: ReturnType<typeof useMessagingStore>, messageId: string): Promise<void> {
  const url = await store.fileUrl(messageId, true);
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Width and height a picture is shown at in a message, keeping its shape (at most 320 x 320). */
function displaySize(attachment: Pick<Attachment, 'width' | 'height'>, max = 320): { width: number; height: number } {
  const width = attachment.width ?? max;
  const height = attachment.height ?? Math.round(max * 0.75);
  const scale = Math.min(max / width, max / height, 1);
  return { width: Math.max(120, Math.round(width * scale)), height: Math.max(80, Math.round(height * scale)) };
}

function fileIcon(attachment: Attachment): IconName {
  if (attachment.mimeType === 'application/pdf' || attachment.fileName?.toLowerCase().endsWith('.pdf')) return 'picture_as_pdf';
  if (/zip|compressed|x-7z|x-rar|x-tar/.test(attachment.mimeType)) return 'folder_zip';
  if (attachment.kind === 'audio') return 'headphones';
  return 'description';
}

/** The file of a message, shown by kind (Phase 4, blueprint: Media). */
export function AttachmentView({ message, attachment, onOpen }: { message: Message; attachment: Attachment; onOpen: () => void }) {
  const store = useMessagingStore();
  switch (attachment.kind) {
    case 'photo':
    case 'video': {
      const size = displaySize(attachment);
      return (
        <button type="button" onClick={onOpen} aria-label={attachment.kind === 'photo' ? 'Open photo' : 'Play video'} className="relative block overflow-hidden rounded-sm bg-surface-subtle" style={size}>
          {attachment.thumbnailUrl ? (
            <img src={attachment.thumbnailUrl} alt="" className="size-full object-cover" style={size} />
          ) : (
            <span className="grid size-full place-items-center text-ink-secondary">
              <Icon name={attachment.kind === 'photo' ? 'image' : 'movie'} size={36} />
            </span>
          )}
          {attachment.kind === 'video' ? (
            <>
              <span className="absolute inset-0 grid place-items-center">
                <span className="grid size-12 place-items-center rounded-full bg-scrim/60 text-on-accent">
                  <Icon name="play_arrow" size={28} />
                </span>
              </span>
              <span className="absolute bottom-1 left-1 rounded-sm bg-scrim/60 px-1 text-[11px] text-on-accent">{formatDuration(attachment.durationMs)}</span>
            </>
          ) : null}
        </button>
      );
    }
    case 'gif':
      return <GifPlayer message={message} attachment={attachment} />;
    case 'video_note':
      return <VideoNotePlayer message={message} attachment={attachment} />;
    case 'voice':
      return <VoicePlayer message={message} attachment={attachment} />;
    case 'audio':
    case 'file':
    default:
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {attachment.kind === 'audio' ? (
            <AudioButton message={message} />
          ) : (
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
              <Icon name={fileIcon(attachment)} size={22} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{attachment.fileName ?? MEDIA_LABEL[attachment.kind]}</span>
            <span className="block text-xs text-ink-secondary">
              {formatBytes(attachment.size)}
              {attachment.kind === 'audio' && attachment.durationMs ? ` · ${formatDuration(attachment.durationMs)}` : ''}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Download ${attachment.fileName ?? 'file'}`}
            onClick={() => void download(store, message.id).catch(() => undefined)}
            className="grid size-9 shrink-0 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Icon name="download" size={20} />
          </button>
        </div>
      );
  }
}

function GifPlayer({ message, attachment }: { message: Message; attachment: Attachment }) {
  const url = useFileUrl(message.id, true);
  const size = displaySize(attachment, 240);
  return (
    <span className="relative block overflow-hidden rounded-sm bg-surface-subtle" style={size}>
      {url ? <video src={url} autoPlay loop muted playsInline className="size-full object-cover" style={size} aria-label="GIF" /> : null}
      <span className="absolute bottom-1 left-1 rounded-sm bg-scrim/60 px-1 text-[11px] font-medium text-on-accent">GIF</span>
    </span>
  );
}

function VideoNotePlayer({ message, attachment }: { message: Message; attachment: Attachment }) {
  const [playing, setPlaying] = useState(false);
  const url = useFileUrl(message.id, playing);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (url && playing) void video.current?.play().catch(() => setPlaying(false));
  }, [url, playing]);
  return (
    <button
      type="button"
      aria-label={playing ? 'Stop video message' : 'Play video message'}
      onClick={() => {
        if (playing) {
          video.current?.pause();
          setPlaying(false);
        } else setPlaying(true);
      }}
      className="relative block size-[200px] overflow-hidden rounded-full bg-surface-subtle"
    >
      {playing && url ? (
        <video ref={video} src={url} playsInline onEnded={() => setPlaying(false)} className="size-full object-cover" />
      ) : attachment.thumbnailUrl ? (
        <img src={attachment.thumbnailUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center text-ink-secondary">
          <Icon name="videocam" size={40} />
        </span>
      )}
      {playing ? null : (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-12 place-items-center rounded-full bg-scrim/60 text-on-accent">
            <Icon name="play_arrow" size={28} />
          </span>
        </span>
      )}
      <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-sm bg-scrim/60 px-1 text-[11px] text-on-accent">{formatDuration(attachment.durationMs)}</span>
    </button>
  );
}

const SPEEDS = [1, 1.5, 2] as const;

/** A voice message: play/pause, waveform with progress, 1x / 1.5x / 2x. */
function VoicePlayer({ message, attachment }: { message: Message; attachment: Attachment }) {
  const [requested, setRequested] = useState(false);
  const url = useFileUrl(message.id, requested);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const bars = attachment.waveform && attachment.waveform.length > 0 ? attachment.waveform : Array.from({ length: 30 }, () => 20);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed, url]);
  useEffect(() => {
    if (url && requested && audio.current && audio.current.paused && playing) void audio.current.play().catch(() => setPlaying(false));
  }, [url, requested, playing]);

  return (
    <div className="flex min-w-[220px] items-center gap-2">
      <button
        type="button"
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        onClick={() => {
          if (playing) {
            audio.current?.pause();
            setPlaying(false);
          } else {
            setRequested(true);
            setPlaying(true);
            if (url) void audio.current?.play().catch(() => setPlaying(false));
          }
        }}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent hover:bg-accent-hover"
      >
        <Icon name={playing ? 'pause' : 'play_arrow'} size={24} />
      </button>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex h-6 items-center gap-[2px]" aria-hidden="true">
          {bars.map((level, index) => (
            <span
              key={index}
              className={`w-[3px] shrink-0 rounded-full ${index / bars.length < progress ? 'bg-accent' : 'bg-ink-disabled'}`}
              style={{ height: `${Math.max(12, level)}%` }}
            />
          ))}
        </span>
        <span className="text-xs text-ink-secondary">{formatDuration(playing || progress > 0 ? (audio.current?.currentTime ?? 0) * 1000 : attachment.durationMs)}</span>
      </span>
      <button
        type="button"
        aria-label={`Playback speed ${speed}x`}
        onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
        className="shrink-0 rounded-sm border border-line px-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-hover"
      >
        {speed}x
      </button>
      {url ? (
        <audio
          ref={audio}
          src={url}
          preload="auto"
          onTimeUpdate={(event) => {
            const element = event.currentTarget;
            const total = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : (attachment.durationMs ?? 1) / 1000;
            setProgress(Math.min(1, element.currentTime / total));
          }}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
        />
      ) : null}
    </div>
  );
}

function AudioButton({ message }: { message: Message }) {
  const [playing, setPlaying] = useState(false);
  const url = useFileUrl(message.id, playing);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (url && playing) void audio.current?.play().catch(() => setPlaying(false));
  }, [url, playing]);
  return (
    <>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => {
          if (playing) audio.current?.pause();
          setPlaying(!playing);
        }}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-on-accent hover:bg-accent-hover"
      >
        <Icon name={playing ? 'pause' : 'play_arrow'} size={24} />
      </button>
      {url ? <audio ref={audio} src={url} onEnded={() => setPlaying(false)} /> : null}
    </>
  );
}

export function StickerView({ sticker }: { sticker: Sticker }) {
  const scale = Math.min(1, 180 / Math.max(sticker.width, sticker.height));
  return <img src={sticker.url} alt={`Sticker ${sticker.emoji}`} width={Math.round(sticker.width * scale)} height={Math.round(sticker.height * scale)} className="block" />;
}

/** Full-screen view of a photo or video, with save. */
export function MediaViewer({ message, onClose }: { message: Message; onClose: () => void }) {
  const store = useMessagingStore();
  const attachment = message.attachment;
  const url = useFileUrl(message.id, attachment !== null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!attachment) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={MEDIA_LABEL[attachment.kind]} className="fixed inset-0 z-50 flex flex-col bg-scrim/90">
      <header className="flex items-center justify-end gap-1 p-2">
        <button type="button" aria-label="Save" onClick={() => void download(store, message.id).catch(() => undefined)} className="grid size-10 place-items-center rounded-sm text-on-accent hover:bg-scrim/40">
          <Icon name="download" />
        </button>
        <button type="button" aria-label="Close" onClick={onClose} className="grid size-10 place-items-center rounded-sm text-on-accent hover:bg-scrim/40">
          <Icon name="close" />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 place-items-center p-4" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
        {!url ? (
          <p className="text-sm text-on-accent">Loading…</p>
        ) : attachment.kind === 'video' ? (
          <video src={url} controls autoPlay playsInline className="max-h-full max-w-full" />
        ) : (
          <img src={url} alt={message.text ?? 'Photo'} className="max-h-full max-w-full object-contain" />
        )}
      </div>
      {message.text ? <p className="max-h-32 overflow-y-auto px-4 pb-4 text-center text-sm text-on-accent">{message.text}</p> : null}
    </div>
  );
}

/** Reaction counts under a message; tapping one adds or takes back one's own. */
export function ReactionChips({ reactions, disabled, onToggle }: { reactions: Reaction[]; disabled: boolean; onToggle: (emoji: string, mine: boolean) => void }) {
  if (reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" aria-label="Reactions">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          disabled={disabled && !reaction.mine}
          aria-pressed={reaction.mine}
          aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', yours' : ''}`}
          onClick={() => onToggle(reaction.emoji, reaction.mine)}
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${reaction.mine ? 'border-accent bg-accent/10 text-accent' : 'border-line text-ink-secondary'} disabled:opacity-60`}
        >
          <span>{reaction.emoji}</span>
          <span>{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}

/** The fixed set of reactions (one per person per message). */
export function ReactionPicker({ current, onPick, onClose }: { current: string | null; onPick: (emoji: string | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && onClose();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" aria-label="React" className="absolute bottom-full z-30 mb-1 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-lg">
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="menuitemradio"
          aria-checked={current === emoji}
          aria-label={`React ${emoji}`}
          onClick={() => onPick(current === emoji ? null : emoji)}
          className={`grid size-9 place-items-center rounded-full text-xl hover:bg-surface-hover ${current === emoji ? 'bg-surface-selected' : ''}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/** A file being uploaded: preview, progress, retry or cancel. */
export function PendingUploadItem({ item, onRetry, onCancel }: { item: PendingUpload; onRetry: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-row-reverse items-start gap-2 py-0.5" aria-label={`Sending ${MEDIA_LABEL[item.kind]}`}>
      <div className="flex max-w-[min(75%,560px)] flex-col gap-1 rounded-md bg-surface-selected px-3 py-2">
        <div className="flex items-center gap-3">
          {item.previewUrl ? (
            <img src={item.previewUrl} alt="" className="size-14 rounded-sm object-cover" />
          ) : (
            <span className="grid size-11 place-items-center rounded-full bg-accent text-on-accent">
              <Icon name={item.kind === 'voice' ? 'mic' : item.kind === 'video_note' ? 'videocam' : item.kind === 'audio' ? 'headphones' : 'description'} size={22} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{item.fileName ?? MEDIA_LABEL[item.kind]}</span>
            <span className="block text-xs text-ink-secondary">
              {item.status === 'failed' ? <span className="text-danger">{item.error}</span> : item.status === 'sending' ? 'Sending…' : `${Math.round(item.progress * 100)}% of ${formatBytes(item.size)}`}
            </span>
          </span>
          {item.status === 'failed' ? (
            <button type="button" aria-label="Retry" onClick={onRetry} className="grid size-8 place-items-center rounded-full text-accent transition-colors hover:bg-accent-soft">
              <Icon name="refresh" size={20} />
            </button>
          ) : null}
          <button type="button" aria-label="Cancel" onClick={onCancel} className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
            <Icon name="close" size={20} />
          </button>
        </div>
        {item.status === 'uploading' ? (
          <span className="h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(item.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span className="block h-full bg-accent transition-[width]" style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </span>
        ) : null}
        {item.caption ? <p className="whitespace-pre-wrap break-words text-sm">{item.caption}</p> : null}
      </div>
    </div>
  );
}

const MEDIA_TABS: Array<{ id: MediaFilter; label: string }> = [
  { id: 'media', label: 'Media' },
  { id: 'files', label: 'Files' },
  { id: 'voice', label: 'Voice' },
];

/** A chat's photos and videos, files and voice messages (blueprint: media index by kind). */
export function MediaPanel({ chatId, onClose, onOpen, onJump }: { chatId: string; onClose: () => void; onOpen: (message: Message) => void; onJump: (message: Message) => void }) {
  const store = useMessagingStore();
  const [tab, setTab] = useState<MediaFilter>('media');
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (kind: MediaFilter, before?: number) => {
      try {
        const page = await store.chatMedia(chatId, kind, before);
        setItems((current) => (before && current ? [...current, ...page] : page));
        setMore(page.length >= 30);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [chatId, store],
  );
  useEffect(() => {
    setItems(null);
    void load(tab);
  }, [tab, load]);

  return (
    <Dialog title="Shared media" onClose={onClose}>
      <div role="tablist" aria-label="Kind" className="mb-3 flex gap-1 border-b border-line">
        {MEDIA_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`px-3 py-2 text-sm ${tab === entry.id ? 'border-b-2 border-accent font-medium text-accent' : 'text-ink-secondary'}`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {items === null ? <p className="text-sm text-ink-secondary">Loading…</p> : null}
      {items?.length === 0 ? <p className="text-sm text-ink-secondary">Nothing here yet.</p> : null}
      {tab === 'media' && items ? (
        <ul className="grid grid-cols-3 gap-1" aria-label="Photos and videos">
          {items.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                aria-label={`Open ${MEDIA_LABEL[message.attachment?.kind ?? 'photo']}`}
                onClick={() => (message.attachment?.kind === 'photo' || message.attachment?.kind === 'video' ? onOpen(message) : onJump(message))}
                className="relative block aspect-square w-full overflow-hidden rounded-sm bg-surface-subtle"
              >
                {message.attachment?.thumbnailUrl ? (
                  <img src={message.attachment.thumbnailUrl} alt="" className="size-full object-cover" />
                ) : (
                  <span className="grid size-full place-items-center text-ink-secondary">
                    <Icon name={message.attachment?.kind === 'gif' ? 'gif_box' : message.attachment?.kind === 'photo' ? 'image' : 'movie'} size={28} />
                  </span>
                )}
                {message.attachment?.kind === 'video' || message.attachment?.kind === 'video_note' ? (
                  <span className="absolute bottom-1 left-1 rounded-sm bg-scrim/60 px-1 text-[11px] text-on-accent">{formatDuration(message.attachment.durationMs)}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {tab !== 'media' && items ? (
        <ul className="flex flex-col gap-3" aria-label={tab === 'files' ? 'Files' : 'Voice messages'}>
          {items.map((message) =>
            message.attachment ? (
              <li key={message.id} className="flex flex-col gap-1">
                <AttachmentView message={message} attachment={message.attachment} onOpen={() => onOpen(message)} />
                <button type="button" onClick={() => onJump(message)} className="self-start text-xs text-accent">
                  {new Date(message.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · Show in chat
                </button>
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      {more && items && items.length > 0 ? (
        <button type="button" onClick={() => void load(tab, items[items.length - 1]!.seq)} className="mt-3 w-full rounded-sm border border-line py-2 text-sm hover:bg-surface-hover">
          Show more
        </button>
      ) : null}
    </Dialog>
  );
}

/** Emojis offered in the composer (the device's own emoji font draws them). */
const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😜', '🤪', '🤗',
  '🤭', '🤔', '🤐', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '😌', '😔', '😪', '😴', '😷', '🤒', '🤕', '🥵', '🥶', '😵',
  '🤯', '🥳', '😎', '🤓', '😕', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱',
  '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌', '👐', '🙏',
  '💪', '👋', '✋', '👀', '🧠', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '✨', '🔥', '🎉', '🎊', '🎓', '📚',
  '✏️', '📝', '📌', '📎', '✅', '❌', '❓', '❗', '⭐', '🌟', '☀️', '🌙', '⏰', '📅', '☕', '🍕', '🎂', '⚽', '🏆', '🚀',
];

type PickerTab = 'emoji' | 'stickers' | 'gifs';

/** Emojis (into the text), stickers and GIFs (sent straight away). */
export function ExpressionPicker({
  onEmoji,
  onSticker,
  onGif,
  onClose,
  stickersAllowed = true,
}: {
  onEmoji: (emoji: string) => void;
  onSticker: (sticker: Sticker) => void;
  onGif: (gif: Gif) => void;
  onClose: () => void;
  /** Phase 5: a group may not allow stickers and GIFs for this member. */
  stickersAllowed?: boolean;
}) {
  const store = useMessagingStore();
  const [tab, setTab] = useState<PickerTab>('emoji');
  const [packs, setPacks] = useState<StickerPack[] | null>(null);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<{ enabled: boolean; items: Gif[]; next: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: PointerEvent) => !ref.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-expression-toggle]') && onClose();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (tab === 'stickers' && packs === null) {
      store
        .stickers()
        .then(setPacks)
        .catch((caught: unknown) => setError(errorMessage(caught)));
    }
  }, [tab, packs, store]);

  useEffect(() => {
    if (tab !== 'gifs') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      store
        .searchGifs(query.trim())
        .then((result) => !cancelled && setGifs({ enabled: result.enabled, items: result.gifs, next: result.nextOffset }))
        .catch((caught: unknown) => !cancelled && setError(errorMessage(caught)));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, query, store]);

  return (
    <div ref={ref} className="absolute bottom-full left-0 z-30 mb-2 flex h-80 w-[min(360px,calc(100vw-24px))] flex-col rounded-md border border-line bg-surface shadow-lg" role="dialog" aria-label="Emoji, stickers and GIFs">
      <div role="tablist" className="flex shrink-0 gap-1 border-b border-line px-2">
        {(
          [
            ['emoji', 'Emoji'],
            ['stickers', 'Stickers'],
            ['gifs', 'GIFs'],
          ] as const
        )
          .filter(([id]) => stickersAllowed || id === 'emoji')
          .map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`px-3 py-2 text-sm ${tab === id ? 'border-b-2 border-accent font-medium text-accent' : 'text-ink-secondary'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? <p className="p-2 text-sm text-danger">{error}</p> : null}
        {tab === 'emoji' ? (
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJIS.map((emoji) => (
              <button key={emoji} type="button" aria-label={emoji} onClick={() => onEmoji(emoji)} className="grid aspect-square place-items-center rounded-sm text-2xl hover:bg-surface-hover">
                {emoji}
              </button>
            ))}
          </div>
        ) : null}
        {tab === 'stickers' ? (
          packs === null ? (
            <p className="p-2 text-sm text-ink-secondary">Loading…</p>
          ) : packs.length === 0 ? (
            <p className="p-2 text-sm text-ink-secondary">No stickers yet.</p>
          ) : (
            packs.map((pack) => (
              <section key={pack.id} className="mb-2">
                <h3 className="px-1 pb-1 text-xs font-medium text-ink-secondary">{pack.name}</h3>
                <div className="grid grid-cols-4 gap-1">
                  {pack.stickers.map((sticker) => (
                    <button key={sticker.id} type="button" aria-label={`Send sticker ${sticker.emoji}`} onClick={() => onSticker(sticker)} className="grid aspect-square place-items-center rounded-sm p-1 hover:bg-surface-hover">
                      <img src={sticker.url} alt={sticker.emoji} className="max-h-full max-w-full object-contain" loading="lazy" />
                    </button>
                  ))}
                </div>
              </section>
            ))
          )
        ) : null}
        {tab === 'gifs' ? (
          <>
            <label htmlFor="gif-search" className="sr-only">
              Search GIFs
            </label>
            <input
              id="gif-search"
              type="search"
              value={query}
              maxLength={50}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search GIFs"
              className="mb-2 h-9 w-full rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
            />
            {gifs === null ? <p className="p-2 text-sm text-ink-secondary">Loading…</p> : null}
            {gifs && !gifs.enabled ? <p className="p-2 text-sm text-ink-secondary">GIFs are not available yet.</p> : null}
            {gifs?.enabled && gifs.items.length === 0 ? <p className="p-2 text-sm text-ink-secondary">No GIFs found.</p> : null}
            <div className="grid grid-cols-2 gap-1">
              {gifs?.items.map((gif) => (
                <button key={gif.id} type="button" aria-label={`Send GIF ${gif.title}`} onClick={() => onGif(gif)} className="overflow-hidden rounded-sm bg-surface-subtle hover:opacity-90">
                  <img src={gif.previewUrl} alt={gif.title} className="h-28 w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
            {gifs?.next ? (
              <button
                type="button"
                onClick={() =>
                  void store
                    .searchGifs(query.trim(), gifs.next ?? 0)
                    .then((result) => setGifs({ enabled: result.enabled, items: [...gifs.items, ...result.gifs], next: result.nextOffset }))
                    .catch((caught: unknown) => setError(errorMessage(caught)))
                }
                className="mt-2 w-full rounded-sm border border-line py-1.5 text-sm hover:bg-surface-hover"
              >
                More GIFs
              </button>
            ) : null}
            <p className="mt-2 text-center text-[11px] text-ink-secondary">Powered by GIPHY</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
