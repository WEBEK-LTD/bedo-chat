'use client';

import type { Chat, Message } from '@bedo/contracts';
import { Icon, type IconName } from '@bedo/ui';
import { useState } from 'react';
import { MEDIA_LABEL } from '../../_lib/messaging/media';
import type { PendingMessage } from '../../_lib/messaging/store';
import { canPost, type DeliveryStatus, deliveryStatus, STATUS_LABEL, timeOf } from './format';
import { PollView } from './groups';
import { AttachmentView, ReactionChips, ReactionPicker, StickerView } from './media';
import { ActionMenu, type MenuItem } from './menu';
import { Avatar } from '../ui';

const STATUS_ICON: Record<DeliveryStatus, IconName> = {
  sending: 'schedule',
  failed: 'error',
  sent: 'check',
  delivered: 'done_all',
  seen: 'done_all',
};

function StatusMark({ status }: { status: DeliveryStatus }) {
  return (
    <Icon
      name={STATUS_ICON[status]}
      size={16}
      title={STATUS_LABEL[status]}
      className={status === 'failed' ? 'text-danger' : undefined}
    />
  );
}

export interface MessageActions {
  onToggleSelect: () => void;
  onReply: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onShare: () => void;
  onForward: () => void;
  onPin: (pin: boolean) => void;
  onSelect: () => void;
  onDelete: () => void;
  onReport: () => void;
  onJumpToReply: () => void;
  /** Phase 4: open a photo or video full screen, save a file, react. */
  onOpenMedia: () => void;
  onSaveFile: () => void;
  onReact: (emoji: string | null) => void;
  /** Phase 5: a tapped #hashtag searches the chat for it. */
  onHashtag: (tag: string) => void;
  onNotice?: (message: string) => void;
}

/** Text with @mentions highlighted and #hashtags as buttons that search the chat (Phase 5). */
function RichText({ text, onHashtag }: { text: string; onHashtag: (tag: string) => void }) {
  const parts: Array<string | { kind: 'mention' | 'tag'; value: string }> = [];
  const pattern = /(^|[^\p{L}\p{N}_@#])([@#][\p{L}\p{N}_]{2,64})/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1]!.length;
    if (start > last) parts.push(text.slice(last, start));
    const token = match[2]!;
    parts.push({ kind: token.startsWith('@') ? 'mention' : 'tag', value: token });
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : part.kind === 'mention' ? (
          <span key={index} className="font-medium text-accent">
            {part.value}
          </span>
        ) : (
          <button key={index} type="button" onClick={() => onHashtag(part.value)} className="text-accent hover:underline">
            {part.value}
          </button>
        ),
      )}
    </p>
  );
}

/** What a reply shows of the message it answers. */
export function replyText(reply: NonNullable<Message['replyTo']>): string {
  if (reply.text) return reply.text;
  return reply.media ? MEDIA_LABEL[reply.media] : 'Deleted message';
}

/** One message: text, reply and forward headers, edited mark, status of one's own messages, actions. */
export function MessageItem({
  message,
  chat,
  mine,
  showAvatar = true,
  pinned,
  selecting,
  selected,
  ...actions
}: { message: Message; chat: Chat; mine: boolean; showAvatar?: boolean; pinned: boolean; selecting: boolean; selected: boolean } & MessageActions) {
  const canAct = !message.deleted;
  const canSend = canPost(chat);
  const group = chat.group;
  const canPin = group ? group.permissions.includes('pin_messages') || group.adminRights.includes('pin_messages') : canSend;
  const canReact = canSend || chat.type === 'channel';
  const [picking, setPicking] = useState(false);
  const myReaction = message.reactions.find((reaction) => reaction.mine)?.emoji ?? null;
  const items: MenuItem[] = [
    ...(canAct && canSend ? [{ label: 'Reply', icon: 'reply' as const, onSelect: actions.onReply }] : []),
    // Channel subscribers cannot post, but they react (D-40).
    ...(canAct && canReact ? [{ label: 'React', icon: 'add_reaction' as const, onSelect: () => setPicking(true) }] : []),
    ...(canAct && mine && canSend && message.kind !== 'sticker' && message.kind !== 'poll' ? [{ label: message.kind === 'media' && !message.text ? 'Add caption' : 'Edit', icon: 'edit' as const, onSelect: actions.onEdit }] : []),
    ...(canAct && message.text ? [{ label: 'Copy text', icon: 'content_copy' as const, onSelect: actions.onCopy }] : []),
    ...(canAct && message.attachment ? [{ label: 'Save file', icon: 'download' as const, onSelect: actions.onSaveFile }] : []),
    ...(canAct && message.text ? [{ label: 'Share', icon: 'share' as const, onSelect: actions.onShare }] : []),
    ...(canAct ? [{ label: 'Forward', icon: 'forward' as const, onSelect: actions.onForward }] : []),
    ...(canAct && (canPin || (!group && pinned)) ? [{ label: pinned ? 'Unpin' : 'Pin', icon: pinned ? ('keep_off' as const) : ('keep' as const), onSelect: () => actions.onPin(!pinned) }] : []),
    { label: 'Select', icon: 'check_circle', onSelect: actions.onSelect },
    { label: 'Delete', icon: 'delete', danger: true, onSelect: actions.onDelete },
    // A channel's posts are reported through its admins, not by sender (subscribers do not see who posted).
    ...(!mine && canAct && message.senderId !== chat.id && !(chat.peer?.deleted ?? message.sender?.deleted ?? false) ? [{ label: 'Report', icon: 'flag' as const, danger: true, onSelect: actions.onReport }] : []),
  ];
  const status = mine ? deliveryStatus(message, chat) : null;
  // Phase 15: who sent it, with their picture: the other person in a private chat, the sender in a group. Not for
  // one's own messages, nor channel posts (they come from the channel).
  const author = mine
    ? null
    : chat.type === 'private'
      ? chat.peer
        ? { displayName: chat.peer.displayName, photoUrl: chat.peer.photoUrl }
        : null
      : chat.type === 'group' && message.sender
        ? { displayName: message.sender.displayName, photoUrl: message.sender.photoUrl }
        : null;

  return (
    <div id={`message-${message.id}`} className={`group flex items-start gap-2 rounded-sm py-0.5 transition-colors ${mine ? 'flex-row-reverse' : ''}`}>
      {author ? (
        <div className="w-[34px] shrink-0 self-end" aria-hidden={showAvatar ? undefined : true}>
          {showAvatar ? (
            <span title={author.displayName} data-testid="sender-avatar">
              <Avatar name={author.displayName} photoUrl={author.photoUrl} size={34} />
            </span>
          ) : null}
        </div>
      ) : null}
      {selecting ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label="Select message"
          onClick={actions.onToggleSelect}
          className="mt-2 grid size-6 shrink-0 place-items-center text-accent"
        >
          <Icon name={selected ? 'check_circle' : 'radio_button_unchecked'} size={22} />
        </button>
      ) : null}
      <div
        className={`relative max-w-[min(78%,560px)] ${message.mentionsMe && !message.deleted ? 'ring-2 ring-accent/60 ' : ''}${message.sticker && !message.deleted ? 'bg-transparent px-0' : `bedo-bubble ${mine ? 'bedo-bubble-out' : 'bedo-bubble-in'} px-3`} py-1.5 ${message.deleted ? 'italic opacity-75' : ''}`}
        onClick={selecting ? actions.onToggleSelect : undefined}
      >
        {picking ? (
          <ReactionPicker
            current={myReaction}
            onPick={(emoji) => {
              setPicking(false);
              actions.onReact(emoji);
            }}
            onClose={() => setPicking(false)}
          />
        ) : null}
        {message.sender && !mine && !message.deleted ? <p className="text-[13px] font-semibold text-accent">{message.sender.displayName}</p> : null}
        {message.mentionsMe && !message.deleted ? <span className="sr-only">Mentions you</span> : null}
        {message.forwardedFrom ? (
          <p className="flex items-center gap-1 text-xs text-accent">
            <Icon name="forward" size={14} />
            Forwarded from {message.forwardedFrom.displayName}
          </p>
        ) : null}
        {message.replyTo ? (
          <button type="button" onClick={actions.onJumpToReply} className="mb-1 mt-0.5 block w-full rounded-[6px] border-l-[3px] border-accent bg-accent/10 py-1 pl-2 pr-2 text-left">
            <span className="block text-xs font-semibold text-accent">{message.replyTo.senderId === message.senderId ? 'Reply' : 'In reply to'}</span>
            <span className="block truncate text-xs opacity-80">{replyText(message.replyTo)}</span>
          </button>
        ) : null}
        {!message.deleted && message.attachment ? (
          <div className="my-1">
            <AttachmentView message={message} attachment={message.attachment} onOpen={actions.onOpenMedia} />
          </div>
        ) : null}
        {!message.deleted && message.sticker ? <StickerView sticker={message.sticker} /> : null}
        {!message.deleted && message.poll ? (
          <PollView message={message} poll={message.poll} mine={mine} canManage={Boolean(group?.adminRights.includes('delete_messages'))} onNotice={actions.onNotice ?? (() => undefined)} />
        ) : null}
        {message.deleted ? (
          <p className="whitespace-pre-wrap break-words">This message was deleted.</p>
        ) : message.text ? (
          <RichText text={message.text} onHashtag={actions.onHashtag} />
        ) : null}
        <ReactionChips reactions={message.reactions} disabled={!canReact} onToggle={(emoji, isMine) => actions.onReact(isMine ? null : emoji)} />
        <p className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] ${mine ? 'opacity-70' : 'text-ink-secondary'}`}>
          {pinned ? <Icon name="keep" size={12} title="Pinned" /> : null}
          {message.editedAt && !message.deleted ? <span>edited</span> : null}
          <time dateTime={message.createdAt}>{timeOf(message.createdAt)}</time>
          {status ? <StatusMark status={status} /> : null}
        </p>
      </div>
      {selecting ? null : (
        <div className={`flex items-center self-center opacity-40 focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100 ${mine ? 'flex-row-reverse' : ''}`}>
          <ActionMenu label="Message actions" items={items} align={mine ? 'right' : 'left'} />
          {canAct && canReact ? (
            <button type="button" aria-label="React" onClick={() => setPicking(true)} className="hidden size-8 place-items-center rounded-full text-ink-secondary hover:bg-surface md:grid">
              <Icon name="add_reaction" size={18} />
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A message stored on this device and not yet acknowledged (sending), or refused (failed, with retry). */
export function PendingItem({ item, onRetry, onDiscard }: { item: PendingMessage; onRetry: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-row-reverse items-start gap-2 py-0.5">
      <div className="bedo-bubble bedo-bubble-out max-w-[min(78%,560px)] px-3 py-1.5">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] opacity-70">
          <time dateTime={item.createdAt}>{timeOf(item.createdAt)}</time>
          <StatusMark status={item.status === 'failed' ? 'failed' : 'sending'} />
        </p>
        {item.status === 'failed' ? (
          <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-xs">
            <span className="text-danger">{item.error ?? 'Not sent. Will retry when you are back online.'}</span>
            <button type="button" onClick={onRetry} className="flex items-center gap-1 text-accent">
              <Icon name="refresh" size={14} />
              Retry
            </button>
            <button type="button" onClick={onDiscard} className="flex items-center gap-1 text-ink-secondary">
              <Icon name="delete" size={14} />
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
