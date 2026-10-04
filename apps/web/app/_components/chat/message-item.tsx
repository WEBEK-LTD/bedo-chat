'use client';

import type { Chat, Message } from '@bedo/contracts';
import { Icon, type IconName } from '@bedo/ui';
import type { PendingMessage } from '../../_lib/messaging/store';
import { type DeliveryStatus, deliveryStatus, STATUS_LABEL, timeOf } from './format';
import { ActionMenu, type MenuItem } from './menu';

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
      className={status === 'seen' ? 'text-accent' : status === 'failed' ? 'text-danger' : 'text-ink-secondary'}
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
}

/** One message: text, reply and forward headers, edited mark, status of one's own messages, actions. */
export function MessageItem({
  message,
  chat,
  mine,
  pinned,
  selecting,
  selected,
  ...actions
}: { message: Message; chat: Chat; mine: boolean; pinned: boolean; selecting: boolean; selected: boolean } & MessageActions) {
  const canAct = !message.deleted;
  const canSend = chat.peer.canMessage;
  const items: MenuItem[] = [
    ...(canAct && canSend ? [{ label: 'Reply', icon: 'reply' as const, onSelect: actions.onReply }] : []),
    ...(canAct && mine && canSend ? [{ label: 'Edit', icon: 'edit' as const, onSelect: actions.onEdit }] : []),
    ...(canAct ? [{ label: 'Copy text', icon: 'content_copy' as const, onSelect: actions.onCopy }] : []),
    ...(canAct ? [{ label: 'Share', icon: 'share' as const, onSelect: actions.onShare }] : []),
    ...(canAct ? [{ label: 'Forward', icon: 'forward' as const, onSelect: actions.onForward }] : []),
    ...(canAct && (canSend || pinned) ? [{ label: pinned ? 'Unpin' : 'Pin', icon: pinned ? ('keep_off' as const) : ('keep' as const), onSelect: () => actions.onPin(!pinned) }] : []),
    { label: 'Select', icon: 'check_circle', onSelect: actions.onSelect },
    { label: 'Delete', icon: 'delete', danger: true, onSelect: actions.onDelete },
    ...(!mine && canAct && !chat.peer.deleted ? [{ label: 'Report', icon: 'flag' as const, danger: true, onSelect: actions.onReport }] : []),
  ];
  const status = mine ? deliveryStatus(message, chat) : null;

  return (
    <div id={`message-${message.id}`} className={`group flex items-start gap-2 rounded-sm py-0.5 transition-colors ${mine ? 'flex-row-reverse' : ''}`}>
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
        className={`max-w-[min(75%,560px)] rounded-md px-3 py-1.5 ${mine ? 'bg-surface-selected' : 'bg-surface'} ${message.deleted ? 'italic text-ink-secondary' : ''}`}
        onClick={selecting ? actions.onToggleSelect : undefined}
      >
        {message.forwardedFrom ? (
          <p className="flex items-center gap-1 text-xs text-accent">
            <Icon name="forward" size={14} />
            Forwarded from {message.forwardedFrom.displayName}
          </p>
        ) : null}
        {message.replyTo ? (
          <button type="button" onClick={actions.onJumpToReply} className="mb-1 block w-full border-l-2 border-accent pl-2 text-left">
            <span className="block text-xs font-medium text-accent">{message.replyTo.senderId === message.senderId ? 'Reply' : 'In reply to'}</span>
            <span className="block truncate text-xs text-ink-secondary">{message.replyTo.text ?? 'Deleted message'}</span>
          </button>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{message.deleted ? 'This message was deleted.' : message.text}</p>
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-ink-secondary">
          {pinned ? <Icon name="keep" size={12} title="Pinned" /> : null}
          {message.editedAt && !message.deleted ? <span>edited</span> : null}
          <time dateTime={message.createdAt}>{timeOf(message.createdAt)}</time>
          {status ? <StatusMark status={status} /> : null}
        </p>
      </div>
      {selecting ? null : (
        <div className="self-center opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <ActionMenu label="Message actions" items={items} align={mine ? 'right' : 'left'} />
        </div>
      )}
    </div>
  );
}

/** A message stored on this device and not yet acknowledged (sending), or refused (failed, with retry). */
export function PendingItem({ item, onRetry, onDiscard }: { item: PendingMessage; onRetry: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-row-reverse items-start gap-2 py-0.5">
      <div className="max-w-[min(75%,560px)] rounded-md bg-surface-selected px-3 py-1.5">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-ink-secondary">
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
