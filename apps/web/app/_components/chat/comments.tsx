'use client';

import { createComment, deleteComment, editComment, listComments } from '@bedo/api-client';
import { type ChannelComment, type Chat, COMMENT_RULES, type Message } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessagingStore } from '../../_lib/messaging/context';
import { MEDIA_LABEL } from '../../_lib/messaging/media';
import { useSwipeBack } from '../../_lib/swipe-back';
import { Avatar, formatDateTime } from '../ui';
import { dayLabel, timeOf } from './format';
import { ActionMenu, type MenuItem } from './menu';
import { RichText } from './message-item';

const cast = <T,>(value: unknown) => value as T;

/** "14:05" today, "Yesterday 14:05", "3 March 14:05". */
function commentTime(iso: string): string {
  const day = dayLabel(iso);
  return day === 'Today' ? timeOf(iso) : `${day} ${timeOf(iso)}`;
}

type Mode = { kind: 'normal' } | { kind: 'reply'; comment: ChannelComment } | { kind: 'edit'; comment: ChannelComment };

/**
 * A channel post's comments, in a panel beside the chat (like the channel info): oldest first, with the author's name
 * and picture, time, edited mark and replies; the author edits and deletes their own, admins who may delete messages
 * delete any. Comments are not pushed to devices: the open panel looks for new ones every 10 seconds.
 */
export function CommentsPanel({
  chat,
  post,
  onClose,
  onNotice,
  onHashtag,
}: {
  chat: Chat;
  post: Message;
  onClose: () => void;
  onNotice: (message: string) => void;
  onHashtag: (tag: string) => void;
}) {
  const store = useMessagingStore();
  const panel = useRef<HTMLElement>(null);
  useSwipeBack(panel, onClose);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [comments, setComments] = useState<ChannelComment[] | null>(null);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [canComment, setCanComment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'normal' });
  const [busy, setBusy] = useState(false);
  /** Pages shown: a refresh loads as many again, so "Show more" is not undone every 10 seconds. */
  const pages = useRef(1);
  /** The client id of the comment being written, kept for retries until it is stored (never stored twice). */
  const clientId = useRef<string | null>(null);
  const latestPost = useRef(post);
  latestPost.current = post;

  const load = useCallback(async () => {
    const loaded: ChannelComment[] = [];
    let after: string | undefined;
    let page = 0;
    let result: Awaited<ReturnType<typeof listComments>>;
    do {
      result = await listComments(post.id, after ? { after } : undefined);
      loaded.push(...cast<ChannelComment[]>(result.comments));
      after = result.nextAfter ?? undefined;
      page += 1;
    } while (after && page < pages.current);
    setComments(loaded);
    setNextAfter(result.nextAfter);
    setCount(result.count);
    setCanComment(result.canComment);
    setError(null);
    // The count under the post follows what the panel shows.
    if (latestPost.current.commentCount !== result.count) store.replaceMessagePublic({ ...latestPost.current, commentCount: result.count });
  }, [post.id, store]);

  useEffect(() => {
    let stopped = false;
    const refresh = () =>
      void load().catch((failure: unknown) => {
        if (!stopped) setError(errorMessage(failure));
      });
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, COMMENT_RULES.refreshSeconds * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [load]);

  async function showMore() {
    if (!nextAfter) return;
    try {
      const result = await listComments(post.id, { after: nextAfter });
      pages.current += 1;
      setComments([...(comments ?? []), ...cast<ChannelComment[]>(result.comments)]);
      setNextAfter(result.nextAfter);
      setCount(result.count);
    } catch (failure) {
      onNotice(errorMessage(failure));
    }
  }

  const trimmed = text.trim();
  const tooLong = Array.from(trimmed).length > COMMENT_RULES.textMaxLength;

  async function submit() {
    if (!trimmed || tooLong || busy) return;
    setBusy(true);
    try {
      if (mode.kind === 'edit') {
        await editComment(mode.comment.id, { text: trimmed });
      } else {
        clientId.current ??= crypto.randomUUID();
        await createComment(post.id, { clientId: clientId.current, text: trimmed, ...(mode.kind === 'reply' ? { replyToId: mode.comment.id } : {}) });
        clientId.current = null;
        // A new comment is at the end: show every page up to it.
        pages.current = Math.max(pages.current, Math.ceil(((count ?? 0) + 1) / COMMENT_RULES.pageSize));
      }
      setText('');
      setMode({ kind: 'normal' });
      await load();
      if (mode.kind !== 'edit') requestAnimationFrame(() => list.current?.scrollTo({ top: list.current.scrollHeight }));
    } catch (failure) {
      onNotice(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function remove(comment: ChannelComment) {
    if (!window.confirm('Delete this comment?')) return;
    try {
      await deleteComment(comment.id);
      if (mode.kind !== 'normal' && mode.comment.id === comment.id) setMode({ kind: 'normal' });
      await load();
    } catch (failure) {
      onNotice(errorMessage(failure));
    }
  }

  const itemsFor = (comment: ChannelComment): MenuItem[] => [
    ...(canComment
      ? [
          {
            label: 'Reply',
            icon: 'reply' as const,
            onSelect: () => {
              clientId.current = null;
              setMode({ kind: 'reply', comment });
              input.current?.focus();
            },
          },
        ]
      : []),
    { label: 'Copy text', icon: 'content_copy', onSelect: () => void navigator.clipboard?.writeText(comment.text).then(() => onNotice('Copied.')).catch(() => undefined) },
    ...(comment.mine && canComment
      ? [
          {
            label: 'Edit',
            icon: 'edit' as const,
            onSelect: () => {
              setMode({ kind: 'edit', comment });
              setText(comment.text);
              input.current?.focus();
            },
          },
        ]
      : []),
    ...(comment.canDelete ? [{ label: 'Delete', icon: 'delete' as const, danger: true, onSelect: () => void remove(comment) }] : []),
  ];

  const postPreview = post.text ?? (post.poll ? post.poll.question : post.attachment ? MEDIA_LABEL[post.attachment.kind] : post.sticker ? MEDIA_LABEL.sticker : '');

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-scrim/30" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={panel} role="dialog" aria-modal="true" aria-label="Comments" className="flex h-full w-full max-w-[440px] flex-col bg-surface">
        <header className="bedo-glass relative z-10 flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 border-b border-line px-2">
          <button type="button" aria-label="Close comments" onClick={onClose} className="grid size-10 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
            <Icon name="close" />
          </button>
          <h2 className="flex-1 font-medium">{count === null ? 'Comments' : count === 1 ? '1 comment' : `${count} comments`}</h2>
        </header>

        <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3 rounded-md border border-line bg-surface-subtle px-3 py-2">
            <p className="text-xs font-semibold text-accent">{chat.group?.title ?? 'Channel'}</p>
            <p dir="auto" className="line-clamp-4 whitespace-pre-wrap break-words text-sm">
              {postPreview}
            </p>
          </div>
          {error ? <p className="py-6 text-center text-sm text-ink-secondary">{error}</p> : null}
          {comments === null && !error ? <p className="py-6 text-center text-sm text-ink-secondary">Loading…</p> : null}
          {comments && comments.length === 0 && !error ? <p className="py-6 text-center text-sm text-ink-secondary">No comments yet. Be the first to comment.</p> : null}
          {comments && comments.length > 0 ? (
            <ul className="flex flex-col gap-1" aria-label="Comments list">
              {comments.map((comment) => (
                <li key={comment.id} data-testid="comment" className="group flex items-start gap-2 py-1">
                  <Avatar name={comment.author.displayName} photoUrl={comment.author.photoUrl} size={32} />
                  <div className={`min-w-0 flex-1 rounded-md px-3 py-1.5 ${comment.mine ? 'bg-accent/10' : 'bg-surface-subtle'}`}>
                    <p className="flex items-baseline gap-2 text-[13px]">
                      <span className="min-w-0 truncate font-semibold text-accent">{comment.author.displayName}</span>
                      <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)} className="shrink-0 text-[11px] text-ink-secondary">
                        {commentTime(comment.createdAt)}
                      </time>
                      {comment.editedAt ? <span className="shrink-0 text-[11px] text-ink-secondary">edited</span> : null}
                    </p>
                    {comment.replyTo ? (
                      <p className="my-0.5 truncate border-l-[3px] border-accent pl-2 text-xs opacity-80">
                        <span className="font-semibold">{comment.replyTo.authorName}</span>: <span dir="auto">{comment.replyTo.text ?? 'Deleted comment'}</span>
                      </p>
                    ) : null}
                    <div className="text-sm">
                      <RichText text={comment.text} onHashtag={onHashtag} />
                    </div>
                  </div>
                  <div className="self-center opacity-60 focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                    <ActionMenu label={`Actions for the comment by ${comment.author.displayName}`} items={itemsFor(comment)} />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {nextAfter ? (
            <button type="button" onClick={() => void showMore()} className="py-2 text-sm text-accent">
              Show more comments
            </button>
          ) : null}
        </div>

        {canComment && !error ? (
          <div className="border-t border-line px-3 py-2">
            {mode.kind !== 'normal' ? (
              <div className="mb-2 flex items-center gap-2 border-l-[3px] border-accent pl-2 text-xs">
                <Icon name={mode.kind === 'edit' ? 'edit' : 'reply'} size={16} className="text-accent" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-accent">{mode.kind === 'edit' ? 'Edit comment' : `Reply to ${mode.comment.author.displayName}`}</span>{' '}
                  <span dir="auto" className="opacity-80">
                    {mode.comment.text}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={mode.kind === 'edit' ? 'Cancel editing' : 'Cancel reply'}
                  onClick={() => {
                    if (mode.kind === 'edit') setText('');
                    setMode({ kind: 'normal' });
                  }}
                  className="grid size-7 place-items-center rounded-full text-ink-secondary hover:bg-surface-hover"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ) : null}
            <form
              className="flex items-end gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label htmlFor="comment-composer" className="sr-only">
                Comment
              </label>
              <textarea
                id="comment-composer"
                ref={input}
                dir="auto"
                value={text}
                rows={1}
                placeholder="Write a comment"
                onChange={(event) => {
                  setText(event.target.value);
                  if (mode.kind !== 'edit') clientId.current = null;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                  if (event.key === 'Escape' && mode.kind !== 'normal') {
                    if (mode.kind === 'edit') setText('');
                    setMode({ kind: 'normal' });
                  }
                }}
                className="max-h-40 min-h-10 flex-1 resize-none rounded-[20px] border border-transparent bg-surface-subtle px-4 py-2 text-[length:var(--bedo-font-size-md)] outline-none transition-[border-color,background-color] placeholder:text-ink-secondary focus:border-accent/50 focus:bg-surface field-sizing-content"
              />
              <button
                type="submit"
                aria-label={mode.kind === 'edit' ? 'Save comment' : 'Send comment'}
                disabled={!trimmed || tooLong || busy}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent shadow-sm transition-[background-color,transform] hover:bg-accent-hover active:scale-95 disabled:opacity-40"
              >
                <Icon name={mode.kind === 'edit' ? 'check' : 'send'} size={20} />
              </button>
            </form>
            {tooLong ? (
              <p className="mt-1 text-right text-xs text-danger">
                {Array.from(trimmed).length}/{COMMENT_RULES.textMaxLength}
              </p>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
