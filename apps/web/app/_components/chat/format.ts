import type { Chat, Message, Peer, Presence } from '@bedo/contracts';
import { MEDIA_LABEL } from '../../_lib/messaging/media';

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Chat list time: the time today, otherwise the date. */
export function listTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return sameDay(date, new Date()) ? timeOf(iso) : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** "online", "last seen today at 14:05", or nothing when hidden (P-18, P-31: to the minute). */
export function presenceText(presence: Presence | null): string {
  if (!presence) return '';
  if (presence.online) return 'online';
  if (!presence.lastSeenAt) return '';
  const label = dayLabel(presence.lastSeenAt);
  const time = timeOf(presence.lastSeenAt);
  return label === 'Today' || label === 'Yesterday' ? `last seen ${label.toLowerCase()} at ${time}` : `last seen ${label} at ${time}`;
}

export function displayName(peer: Peer): string {
  return peer.displayName || 'Bedo Chat user';
}

/** The name a chat is shown under: the other person, or the group's title. */
export function chatTitle(chat: Chat): string {
  return chat.group ? chat.group.title : chat.peer ? displayName(chat.peer) : 'Chat';
}

export function chatPhoto(chat: Chat): string | null {
  return chat.group ? chat.group.photoUrl : (chat.peer?.photoUrl ?? null);
}

export type PostKind = 'text' | 'media' | 'sticker' | 'poll';
const POST_PERMISSION = { text: 'send_messages', media: 'send_media', sticker: 'send_stickers', poll: 'send_polls' } as const;

/** Whether the signed-in user may post this kind of message here (the API decides; this only shapes the composer). */
export function canPost(chat: Chat, kind: PostKind = 'text'): boolean {
  if (chat.group) {
    const allowed = chat.group.permissions as readonly string[];
    return allowed.includes('send_messages') && allowed.includes(POST_PERMISSION[kind]);
  }
  return kind !== 'poll' && (chat.peer?.canMessage ?? false);
}

/** "12 members" when the count is shown to this member, otherwise "Group"; channels: "40 subscribers". */
export function groupSubtitle(chat: Chat): string {
  const count = chat.group?.memberCount;
  if (chat.type === 'channel') {
    return count === null || count === undefined ? 'Channel' : `${count} subscriber${count === 1 ? '' : 's'}`;
  }
  return count === null || count === undefined ? 'Group' : `${count} member${count === 1 ? '' : 's'}`;
}

/** Phase 6: the chat's noun in labels. */
export function chatNoun(chat: Chat): 'chat' | 'group' | 'channel' {
  return chat.type === 'private' ? 'chat' : chat.type;
}

export function isMuted(chat: Chat): boolean {
  return chat.mutedUntil !== null && new Date(chat.mutedUntil).getTime() > Date.now();
}

export function preview(chat: Chat, myId: string): string {
  const message = chat.lastMessage;
  if (!message) return '';
  const text = message.text?.replace(/\s+/g, ' ') ?? null;
  const media = message.sticker
    ? `${message.sticker.emoji} Sticker`
    : message.poll
      ? `📊 ${message.poll.question}`
      : message.attachment
        ? MEDIA_LABEL[message.attachment.kind]
        : null;
  const body = message.deleted ? 'Deleted message' : media ? (text ? `${media}, ${text}` : media) : (text ?? 'Deleted message');
  if (message.senderId === myId) return `You: ${body}`;
  return message.sender ? `${message.sender.displayName.split(' ')[0]}: ${body}` : body;
}

export type DeliveryStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'seen';

/** Status of one's own message (blueprint: Message status). */
export function deliveryStatus(message: Message, chat: Chat): DeliveryStatus {
  if (chat.peerReadSeq >= message.seq) return 'seen';
  if (chat.peerDeliveredSeq >= message.seq) return 'delivered';
  return 'sent';
}

export const STATUS_LABEL: Record<DeliveryStatus, string> = {
  sending: 'Sending',
  failed: 'Not sent',
  sent: 'Sent',
  delivered: 'Delivered',
  seen: 'Seen',
};
