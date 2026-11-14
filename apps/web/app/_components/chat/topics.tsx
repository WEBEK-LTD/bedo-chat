'use client';

import { closeGroupTopic, createGroupTopic, listGroupTopics, reopenGroupTopic, updateGroupTopic, updateGroupTopicSettings } from '@bedo/api-client';
import { type Chat, type GroupTopic, type GroupTopicsResponse, TOPIC_RULES } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessagingStore } from '../../_lib/messaging/context';
import type { TopicSelection } from '../../_lib/messaging/store';
import { Button, TextField } from '../ui';
import { Dialog } from './menu';

const cast = <T,>(value: unknown) => value as T;

/** D-63: a topic's colour, one of the seven avatar tones. */
export function TopicDot({ color, size = 10 }: { color: number; size?: number }) {
  return <span aria-hidden="true" className={`inline-block shrink-0 rounded-full bedo-tone-${Math.abs(color) % TOPIC_RULES.colors}`} style={{ width: size, height: size }} />;
}

const sameSelection = (a: TopicSelection | null, b: TopicSelection | null) =>
  a === null || b === null ? a === b : a.kind === b.kind && (a.kind === 'general' || (b.kind === 'topic' && a.topicId === b.topicId));

/**
 * D-63: the bar under a group's header while topics are on: All (every message, the default), General (messages without
 * a topic) and each topic with its colour; closed topics show a lock.
 */
export function TopicBar({ topics, selected, onSelect }: { topics: GroupTopic[]; selected: TopicSelection | null; onSelect: (topic: TopicSelection | null) => void }) {
  const chip = (key: string, label: string, selection: TopicSelection | null, extra?: { color?: number; closed?: boolean }) => {
    const active = sameSelection(selected, selection);
    return (
      <button
        key={key}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onSelect(selection)}
        className={`flex h-8 max-w-[14rem] shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-colors ${active ? 'bg-accent text-on-accent' : 'bg-surface-subtle text-ink hover:bg-surface-hover'}`}
      >
        {extra?.color !== undefined ? <TopicDot color={extra.color} /> : null}
        <span className="truncate">{label}</span>
        {extra?.closed ? <Icon name="lock" size={14} title="Closed" /> : null}
      </button>
    );
  };
  return (
    <nav className="bedo-glass relative z-10 shrink-0 border-b border-line" aria-label="Topics">
      <div role="tablist" className="flex gap-2 overflow-x-auto px-3 py-2">
        {chip('all', 'All', null)}
        {chip('general', 'General', { kind: 'general' })}
        {topics.map((topic) => chip(topic.id, topic.title, { kind: 'topic', topicId: topic.id }, { color: topic.color, closed: topic.closed }))}
      </div>
    </nav>
  );
}

function TopicDialog({ initial, onClose, onSave }: { initial: GroupTopic | null; onClose: () => void; onSave: (title: string, color: number) => Promise<boolean> }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [color, setColor] = useState(initial?.color ?? 0);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    const ok = await onSave(title.trim(), color);
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog title={initial ? 'Edit topic' : 'New topic'} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <TextField id="topic-title" label="Topic name" value={title} maxLength={TOPIC_RULES.titleMaxLength} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Colour</legend>
          <div className="flex gap-2">
            {Array.from({ length: TOPIC_RULES.colors }, (_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`Colour ${index + 1}`}
                aria-pressed={color === index}
                onClick={() => setColor(index)}
                className={`grid size-8 place-items-center rounded-full ${color === index ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}`}
              >
                <TopicDot color={index} size={22} />
              </button>
            ))}
          </div>
        </fieldset>
        <Button type="submit" busy={busy} disabled={!title.trim()}>
          {initial ? 'Save' : 'Create topic'}
        </Button>
      </form>
    </Dialog>
  );
}

/**
 * D-63: the Topics section of a group's info. Everyone sees whether topics are on and the topics; the owner and admins
 * with the right to change the group's info turn them on or off and create, rename, close and reopen topics.
 */
export function TopicsSection({ chat, onNotice }: { chat: Chat; onNotice: (message: string) => void }) {
  const store = useMessagingStore();
  const [state, setState] = useState<GroupTopicsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<GroupTopic | 'new' | null>(null);
  const enabledInChat = chat.group?.topicsEnabled ?? false;

  const load = useCallback(async () => {
    const result = cast<GroupTopicsResponse>(await listGroupTopics(chat.id));
    setState(result);
    store.setTopics(chat.id, result.enabled ? result.topics : []);
  }, [chat.id, store]);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load, enabledInChat]);

  async function run(action: () => Promise<unknown>, done?: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      await load();
      if (done) onNotice(done);
      return true;
    } catch (error) {
      onNotice(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show before the database update for topics, and nothing for members while topics are off.
  if (!state || !state.available || (!state.enabled && !state.canManage)) return null;
  const open = state.topics.filter((topic) => !topic.closed);
  const closed = state.topics.filter((topic) => topic.closed);

  return (
    <section className="border-t border-line px-4 py-3" aria-label="Topics">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">Topics</h3>
        {state.canManage && state.enabled ? (
          <button type="button" className="flex items-center gap-1 text-sm font-medium text-accent disabled:opacity-50" disabled={busy || state.topics.length >= TOPIC_RULES.maxTopicsPerGroup} onClick={() => setEditing('new')}>
            <Icon name="add" size={18} />
            New topic
          </button>
        ) : null}
      </div>
      {state.canManage ? (
        <label className="mt-2 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            role="switch"
            className="mt-0.5 size-4"
            checked={state.enabled}
            disabled={busy}
            aria-label="Topics"
            onChange={(event) => {
              const on = event.target.checked;
              const previous = state;
              // The switch moves at once; it moves back if the server refuses.
              setState({ ...state, enabled: on });
              void run(async () => {
                try {
                  setState(cast<GroupTopicsResponse>(await updateGroupTopicSettings(chat.id, { enabled: on })));
                } catch (error) {
                  setState(previous);
                  throw error;
                }
                await store.refreshChat(chat.id);
              }, on ? 'Topics turned on.' : 'Topics turned off. Every topic and message is kept.');
            }}
          />
          <span>
            <span className="block font-medium">Organise messages in topics</span>
            <span className="block text-xs text-ink-secondary">
              {state.enabled ? 'Members choose a topic above the messages. Messages without a topic are in General.' : 'Off: everyone sees one conversation. Turning topics off keeps them for later.'}
            </span>
          </span>
        </label>
      ) : null}
      {state.enabled ? (
        <ul className="mt-3 flex flex-col">
          <li className="flex items-center gap-3 py-1.5 text-sm">
            <Icon name="tag" size={18} className="text-ink-secondary" />
            <span className="flex-1">General</span>
          </li>
          {[...open, ...closed].map((topic) => (
            <li key={topic.id} className="flex items-center gap-3 py-1.5 text-sm">
              <TopicDot color={topic.color} size={14} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{topic.title}</span>
                <span className="block text-xs text-ink-secondary">
                  {topic.closed ? 'Closed · ' : ''}
                  {topic.messageCount === 1 ? '1 message' : `${topic.messageCount} messages`}
                </span>
              </span>
              {state.canManage ? (
                <>
                  <button type="button" aria-label={`Edit ${topic.title}`} disabled={busy} onClick={() => setEditing(topic)} className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
                    <Icon name="edit" size={18} />
                  </button>
                  <button
                    type="button"
                    aria-label={topic.closed ? `Reopen ${topic.title}` : `Close ${topic.title}`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => (topic.closed ? reopenGroupTopic(chat.id, topic.id) : closeGroupTopic(chat.id, topic.id)),
                        topic.closed ? 'Topic reopened.' : 'Topic closed: only admins can post in it.',
                      )
                    }
                    className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
                  >
                    <Icon name={topic.closed ? 'lock_reset' : 'lock'} size={18} />
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <TopicDialog
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={(title, color) =>
            editing === 'new'
              ? run(() => createGroupTopic(chat.id, { title, color }), 'Topic created.')
              : run(() => updateGroupTopic(chat.id, editing.id, { title, color }), 'Topic saved.')
          }
        />
      ) : null}
    </section>
  );
}
