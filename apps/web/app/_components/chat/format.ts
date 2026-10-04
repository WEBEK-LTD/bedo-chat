import type { Chat, Message, Peer, Presence } from '@bedo/contracts';

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

export function preview(chat: Chat, myId: string): string {
  const message = chat.lastMessage;
  if (!message) return '';
  const body = message.deleted || message.text === null ? 'Deleted message' : message.text.replace(/\s+/g, ' ');
  return message.senderId === myId ? `You: ${body}` : body;
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
