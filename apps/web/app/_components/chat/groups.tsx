'use client';

import {
  addGroupMembers,
  approveJoinRequest,
  closePoll,
  confirmGroupPhoto,
  createChannel,
  createGroup,
  createInviteLink,
  declineJoinRequest,
  deleteGroup,
  joinWithInvite,
  leaveGroup,
  listGroupMembers,
  listInviteLinks,
  listJoinRequests,
  listPollVoters,
  previewInvite,
  removeGroupMember,
  removeGroupPhoto,
  retractPollVote,
  revokeInviteLink,
  updateInviteLink,
  sendMessage,
  startGroupPhotoUpload,
  transferGroupOwnership,
  updateGroup,
  updateGroupMember,
  updateGroupSettings,
  votePoll,
} from '@bedo/api-client';
import {
  type AdminRight,
  adminRightsFor,
  type Chat,
  CHANNEL_RULES,
  GROUP_RULES,
  type GroupMember,
  type InviteLink,
  type InvitePreview,
  MEMBER_PERMISSIONS,
  type MemberPermission,
  type Message,
  type Peer,
  type Poll,
  type PublicUser,
} from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessagingStore } from '../../_lib/messaging/context';
import { useSwipeBack } from '../../_lib/swipe-back';
import { Avatar, Button, FormError, TextField } from '../ui';
import { chatPhoto, chatTitle, groupSubtitle } from './format';
import { ActionMenu, Dialog, type MenuItem } from './menu';

const cast = <T,>(value: unknown) => value as T;

export const RIGHT_LABELS: Record<AdminRight, string> = {
  change_info: 'Change group info',
  delete_messages: "Delete others' messages",
  restrict_members: 'Restrict and remove members',
  invite_users: 'Add members and manage invite links',
  approve_requests: 'Approve join requests',
  pin_messages: 'Pin messages',
  manage_admins: 'Manage admins',
  change_privacy: 'Change member privacy',
  post_messages: 'Post messages',
};

/** Phase 6: rights that mean something in each kind of chat (channels have no member permissions or privacy switches). */
export const rightsFor = (type: Chat['type']): AdminRight[] => adminRightsFor(type);

export const PERMISSION_LABELS: Record<MemberPermission, string> = {
  send_messages: 'Send messages',
  send_media: 'Send media and files',
  send_stickers: 'Send stickers and GIFs',
  send_polls: 'Send polls',
  add_members: 'Add members',
  pin_messages: 'Pin messages',
  change_info: 'Change group info',
};

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: '', subscriber: '' } as const;

/** A checkbox that shows the change at once and goes back if the server refuses it. */
function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => Promise<boolean> }) {
  const [value, setValue] = useState(checked);
  useEffect(() => setValue(checked), [checked]);
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.checked;
          setValue(next);
          void onChange(next).then((ok) => !ok && setValue(!next));
        }}
      />
      {label}
    </label>
  );
}

/** The site's address for an invite link: https://bedochat.com/?join=<code>. */
export const inviteUrl = (code: string) => `${window.location.origin}/?join=${code}`;

function useAsync(onNotice: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string) => {
      setBusy(true);
      try {
        await action();
        if (done) onNotice(done);
        return true;
      } catch (error) {
        onNotice(errorMessage(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onNotice],
  );
  return { busy, run };
}

/** People search (P-25) with a list of picked people, for creating a group and adding members. */
function PeoplePicker({ picked, onChange, exclude = [] }: { picked: Peer[]; onChange: (people: Peer[]) => void; exclude?: string[] }) {
  const store = useMessagingStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Peer[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.replace(/^@/, '').length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      store
        .searchPeople(q)
        .then((people) => !cancelled && setResults(people))
        .catch(() => !cancelled && setResults([]));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, store]);
  const pickedIds = new Set(picked.map((person) => person.id));
  return (
    <div className="flex flex-col gap-2">
      {picked.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Chosen people">
          {picked.map((person) => (
            <li key={person.id} className="flex items-center gap-1 rounded-full bg-surface-selected py-0.5 pl-2 pr-1 text-sm">
              {person.displayName}
              <button type="button" aria-label={`Remove ${person.displayName}`} onClick={() => onChange(picked.filter((item) => item.id !== person.id))} className="grid size-5 place-items-center rounded-full hover:bg-surface-hover">
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <TextField id="people-search" label="Add people" value={query} onChange={(event) => setQuery(event.target.value)} hint="Type at least 3 characters of a name or username." />
      <ul className="max-h-48 overflow-y-auto" aria-label="People found">
        {results
          .filter((person) => !exclude.includes(person.id))
          .map((person) => (
            <li key={person.id}>
              <button
                type="button"
                disabled={!person.canMessage}
                aria-pressed={pickedIds.has(person.id)}
                onClick={() => onChange(pickedIds.has(person.id) ? picked.filter((item) => item.id !== person.id) : [...picked, person])}
                className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-50"
              >
                <Avatar name={person.displayName} photoUrl={person.photoUrl} size={32} />
                <span className="min-w-0 flex-1 truncate text-sm">{person.displayName}</span>
                {pickedIds.has(person.id) ? <Icon name="check" size={18} className="text-accent" /> : null}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Creating a group: a title, an optional description, and the first members. */
export function NewGroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (chat: Chat) => void }) {
  const store = useMessagingStore();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [people, setPeople] = useState<Peer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const chat = cast<Chat>(await createGroup({ title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), memberIds: people.map((person) => person.id) }));
      store.upsertChat(chat);
      onCreated(chat);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="New group" onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <TextField id="group-title" label="Group name" value={title} maxLength={GROUP_RULES.titleMaxLength} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <TextField id="group-description" label="Description (optional)" value={description} maxLength={GROUP_RULES.descriptionMaxLength} onChange={(event) => setDescription(event.target.value)} />
        <PeoplePicker picked={people} onChange={(list) => setPeople(list.slice(0, GROUP_RULES.addAtOnce))} />
        <FormError message={error} />
        <Button type="submit" disabled={busy || !title.trim()}>
          Create group
        </Button>
      </form>
    </Dialog>
  );
}

/** Phase 6: creating a channel (public: anyone in the academy finds and joins it; private: invite links only). */
export function NewChannelDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (chat: Chat) => void }) {
  const store = useMessagingStore();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setPublic] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const chat = cast<Chat>(await createChannel({ title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}), isPublic }));
      store.upsertChat(chat);
      onCreated(chat);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="New channel" onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <TextField id="channel-title" label="Channel name" value={title} maxLength={GROUP_RULES.titleMaxLength} onChange={(event) => setTitle(event.target.value)} autoFocus />
        <TextField id="channel-description" label="Description (optional)" value={description} maxLength={GROUP_RULES.descriptionMaxLength} onChange={(event) => setDescription(event.target.value)} />
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1 font-medium">Who can join</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="channel-type" checked={isPublic} onChange={() => setPublic(true)} className="mt-1" />
            <span>
              Public channel
              <span className="block text-xs text-ink-secondary">Anyone in the academy can find it in search and join.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="channel-type" checked={!isPublic} onChange={() => setPublic(false)} className="mt-1" />
            <span>
              Private channel
              <span className="block text-xs text-ink-secondary">Only people with an invite link can join.</span>
            </span>
          </label>
        </fieldset>
        <p className="text-xs text-ink-secondary">Subscribers read and react; only you and the admins you choose can post (up to {CHANNEL_RULES.maxSubscribers.toLocaleString()} subscribers).</p>
        <FormError message={error} />
        <Button type="submit" disabled={busy || !title.trim()}>
          Create channel
        </Button>
      </form>
    </Dialog>
  );
}

/** What an invite link (https://bedochat.com/?join=...) leads to, with Join or Ask to join. */
export function JoinDialog({ code, onClose, onJoined }: { code: string; onClose: () => void; onJoined: (chatId: string) => void }) {
  const store = useMessagingStore();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    previewInvite(code)
      .then((result) => setPreview(cast<InvitePreview>(result)))
      .catch(() => setError('This invite link is not valid any more.'));
  }, [code]);
  async function join() {
    setBusy(true);
    try {
      const result = await joinWithInvite(code);
      if (result.status === 'joined' && result.chatId) {
        await store.refreshChat(result.chatId);
        onJoined(result.chatId);
      } else {
        setPreview((current) => (current ? { ...current, requested: true } : current));
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const noun = preview?.type === 'channel' ? 'channel' : 'group';
  return (
    <Dialog title={`Join ${noun}`} onClose={onClose}>
      {error ? <FormError message={error} /> : null}
      {!preview && !error ? <p className="text-sm text-ink-secondary">Loading…</p> : null}
      {preview ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <Avatar name={preview.title} photoUrl={preview.photoUrl} size={80} />
          <p className="text-[length:var(--bedo-font-size-lg)] font-medium">{preview.title}</p>
          {preview.memberCount !== null ? <p className="text-sm text-ink-secondary">{preview.memberCount} {noun === 'channel' ? 'subscribers' : 'members'}</p> : null}
          {preview.description ? <p className="whitespace-pre-wrap text-sm">{preview.description}</p> : null}
          {preview.chatId ? (
            <Button onClick={() => onJoined(preview.chatId!)}>Open {noun}</Button>
          ) : preview.requested ? (
            <p className="text-sm text-ink-secondary">Your request was sent. An admin will review it.</p>
          ) : (
            <Button onClick={() => void join()} disabled={busy}>
              {preview.requiresApproval ? 'Ask to join' : `Join ${noun}`}
            </Button>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Creating a poll or a quiz (groups). */
export function PollComposer({ chatId, onClose, onNotice }: { chatId: string; onClose: () => void; onNotice: (message: string) => void }) {
  const store = useMessagingStore();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [anonymous, setAnonymous] = useState(true);
  const [multiple, setMultiple] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [explanation, setExplanation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const filled = options.map((option) => option.trim()).filter(Boolean);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const message = cast<Message>(
        await sendMessage(chatId, {
          clientId: crypto.randomUUID(),
          poll: {
            question: question.trim(),
            options: filled,
            kind: quiz ? 'quiz' : 'regular',
            anonymous,
            multiple: quiz ? false : multiple,
            ...(quiz ? { correctOption: Math.min(correct, filled.length - 1), ...(explanation.trim() ? { explanation: explanation.trim() } : {}) } : {}),
          },
        }),
      );
      store.replaceMessagePublic(message);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      onNotice(errorMessage(caught));
    }
  }
  return (
    <Dialog title={quiz ? 'New quiz' : 'New poll'} onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <TextField id="poll-question" label="Question" value={question} maxLength={GROUP_RULES.pollQuestionMaxLength} onChange={(event) => setQuestion(event.target.value)} autoFocus />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Options</legend>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              {quiz ? <input type="radio" name="correct" aria-label={`Option ${index + 1} is the right answer`} checked={correct === index} onChange={() => setCorrect(index)} /> : null}
              <input
                aria-label={`Option ${index + 1}`}
                value={option}
                maxLength={GROUP_RULES.pollOptionMaxLength}
                onChange={(event) => setOptions(options.map((item, at) => (at === index ? event.target.value : item)))}
                className="h-9 flex-1 rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
              />
              {options.length > 2 ? (
                <button type="button" aria-label={`Remove option ${index + 1}`} onClick={() => setOptions(options.filter((_, at) => at !== index))} className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
                  <Icon name="close" size={18} />
                </button>
              ) : null}
            </div>
          ))}
          {options.length < GROUP_RULES.pollMaxOptions ? (
            <button type="button" onClick={() => setOptions([...options, ''])} className="self-start text-sm text-accent">
              Add an option
            </button>
          ) : null}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} />
          Anonymous voting
        </label>
        {quiz ? null : (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={multiple} onChange={(event) => setMultiple(event.target.checked)} />
            Several answers allowed
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={quiz} onChange={(event) => setQuiz(event.target.checked)} />
          Quiz (one right answer)
        </label>
        {quiz ? <TextField id="poll-explanation" label="Explanation (optional)" value={explanation} maxLength={GROUP_RULES.pollExplanationMaxLength} onChange={(event) => setExplanation(event.target.value)} /> : null}
        <FormError message={error} />
        <Button type="submit" disabled={!question.trim() || filled.length < 2}>
          Send
        </Button>
      </form>
    </Dialog>
  );
}

/** A poll or quiz inside a message. */
export function PollView({ message, poll, mine, canManage, onNotice }: { message: Message; poll: Poll; mine: boolean; canManage: boolean; onNotice: (message: string) => void }) {
  const store = useMessagingStore();
  const [choice, setChoice] = useState<number[]>([]);
  const [voters, setVoters] = useState<PublicUser[][] | null>(null);
  const voted = poll.myVotes !== null;
  const showResults = voted || poll.closed;
  const act = async (action: () => Promise<unknown>) => {
    try {
      store.replaceMessagePublic(cast<Message>(await action()));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  };
  const vote = (options: number[]) => void act(() => votePoll(message.id, { options }));
  return (
    <div className="flex min-w-[240px] flex-col gap-2" aria-label={poll.kind === 'quiz' ? 'Quiz' : 'Poll'}>
      <p className="font-medium">{poll.question}</p>
      <p className="text-xs text-ink-secondary">
        {poll.closed ? 'Final results · ' : ''}
        {poll.kind === 'quiz' ? 'Quiz' : poll.anonymous ? 'Anonymous poll' : 'Public poll'}
        {poll.multiple ? ' · several answers' : ''}
      </p>
      <ul className="flex flex-col gap-1.5">
        {poll.options.map((option, index) => {
          const share = poll.totalVoters ? Math.round(((option.votes ?? 0) / poll.totalVoters) * 100) : 0;
          const picked = poll.myVotes?.includes(index) ?? false;
          const right = poll.correctOption === index;
          if (!showResults) {
            return (
              <li key={index}>
                {poll.multiple ? (
                  <label className="flex items-center gap-2 rounded-sm border border-line px-2 py-1.5 text-sm hover:bg-surface-hover">
                    <input type="checkbox" checked={choice.includes(index)} onChange={() => setChoice(choice.includes(index) ? choice.filter((item) => item !== index) : [...choice, index])} />
                    {option.text}
                  </label>
                ) : (
                  <button type="button" onClick={() => vote([index])} className="w-full rounded-sm border border-line px-2 py-1.5 text-left text-sm hover:bg-surface-hover">
                    {option.text}
                  </button>
                )}
              </li>
            );
          }
          return (
            <li key={index} className="flex flex-col gap-0.5 text-sm">
              <span className="flex items-center gap-1">
                <span className="w-10 shrink-0 text-right text-xs font-medium">{share}%</span>
                {picked ? <Icon name={poll.kind === 'quiz' && !right ? 'close' : 'check'} size={16} className={poll.kind === 'quiz' && !right ? 'text-danger' : 'text-accent'} /> : null}
                <span className={right ? 'font-medium text-accent' : ''}>{option.text}</span>
              </span>
              <span className="ml-11 h-1.5 rounded-full bg-line">
                <span className={`block h-full rounded-full ${right ? 'bg-accent' : 'bg-ink-secondary'}`} style={{ width: `${share}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {!showResults && poll.multiple ? (
        <Button className="h-8" disabled={choice.length === 0} onClick={() => vote(choice)}>
          Vote
        </Button>
      ) : null}
      {showResults && poll.explanation ? <p className="rounded-sm bg-surface-subtle p-2 text-xs">{poll.explanation}</p> : null}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <span>{poll.totalVoters === null ? 'Vote to see the results' : `${poll.totalVoters} ${poll.totalVoters === 1 ? 'vote' : 'votes'}`}</span>
        {voted && !poll.closed && poll.kind !== 'quiz' ? (
          <button type="button" onClick={() => void act(() => retractPollVote(message.id))} className="text-accent">
            Retract vote
          </button>
        ) : null}
        {!poll.closed && (mine || canManage) ? (
          <button type="button" onClick={() => void act(() => closePoll(message.id))} className="text-accent">
            Stop poll
          </button>
        ) : null}
        {!poll.anonymous && showResults ? (
          <button
            type="button"
            onClick={() =>
              void listPollVoters(message.id)
                .then((result) => setVoters(result.options.map((entry) => cast<PublicUser[]>(entry.voters))))
                .catch((error: unknown) => onNotice(errorMessage(error)))
            }
            className="text-accent"
          >
            View votes
          </button>
        ) : null}
      </div>
      {voters ? (
        <Dialog title="Votes" onClose={() => setVoters(null)}>
          {poll.options.map((option, index) => (
            <section key={index} className="mb-3">
              <h3 className="text-sm font-medium">{option.text}</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {(voters[index] ?? []).length === 0 ? <li className="text-sm text-ink-secondary">No votes.</li> : null}
                {(voters[index] ?? []).map((user) => (
                  <li key={user.id} className="flex items-center gap-2 text-sm">
                    <Avatar name={user.displayName} photoUrl={user.photoUrl} size={24} />
                    {user.displayName}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </Dialog>
      ) : null}
    </div>
  );
}

const DURATIONS: Array<{ label: string; ms: number | null }> = [
  { label: '1 hour', ms: 3600_000 },
  { label: '1 day', ms: 86_400_000 },
  { label: '1 week', ms: 7 * 86_400_000 },
  { label: 'Until lifted', ms: null },
];

/** Restricting one member: which permissions they lose, and for how long. */
function RestrictDialog({ member, onClose, onSave }: { member: GroupMember; onClose: () => void; onSave: (denied: MemberPermission[], until: string | null) => Promise<boolean> }) {
  const [denied, setDenied] = useState<MemberPermission[]>(member.deniedPermissions.length > 0 ? member.deniedPermissions : ['send_messages']);
  const [duration, setDuration] = useState(0);
  return (
    <Dialog title={`Restrict ${member.user.displayName}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">Take away</legend>
          {MEMBER_PERMISSIONS.map((permission) => (
            <label key={permission} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={denied.includes(permission)} onChange={() => setDenied(denied.includes(permission) ? denied.filter((item) => item !== permission) : [...denied, permission])} />
              {PERMISSION_LABELS[permission]}
            </label>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          For
          <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} className="h-9 rounded-sm border border-line bg-surface px-2">
            {DURATIONS.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={denied.length === 0}
          onClick={() => {
            const ms = DURATIONS[duration]!.ms;
            void onSave(denied, ms === null ? null : new Date(Date.now() + ms).toISOString()).then((ok) => ok && onClose());
          }}
        >
          Restrict
        </Button>
      </div>
    </Dialog>
  );
}

/** Admin rights for one admin; only rights the current member holds can be given. */
function RightsDialog({ member, type, allowed, onClose, onSave }: { member: GroupMember; type: Chat['type']; allowed: readonly AdminRight[]; onClose: () => void; onSave: (rights: AdminRight[]) => Promise<boolean> }) {
  const shown = rightsFor(type);
  const [rights, setRights] = useState<AdminRight[]>(member.role === 'admin' ? member.adminRights : allowed.filter((right) => shown.includes(right) && right !== 'manage_admins' && right !== 'change_privacy'));
  return (
    <Dialog title={`Admin rights of ${member.user.displayName}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {shown.map((right) => (
          <label key={right} className={`flex items-center gap-2 text-sm ${allowed.includes(right) ? '' : 'opacity-50'}`}>
            <input type="checkbox" disabled={!allowed.includes(right)} checked={rights.includes(right)} onChange={() => setRights(rights.includes(right) ? rights.filter((item) => item !== right) : [...rights, right])} />
            {type === 'channel' && right === 'restrict_members' ? 'Remove subscribers' : type === 'channel' && right === 'change_info' ? 'Change channel info' : RIGHT_LABELS[right]}
          </label>
        ))}
        <Button onClick={() => void onSave(rights.filter((right) => shown.includes(right))).then((ok) => ok && onClose())}>Save</Button>
      </div>
    </Dialog>
  );
}

/** Group info: details, members (when this member may see them), invite links, requests, settings, leave. */
export function GroupInfoPanel({ chat, myId, onClose, onNotice, onLeft }: { chat: Chat; myId: string; onClose: () => void; onNotice: (message: string) => void; onLeft: () => void }) {
  const store = useMessagingStore();
  const panel = useRef<HTMLElement>(null);
  useSwipeBack(panel, onClose);
  const group = chat.group!;
  const channel = chat.type === 'channel';
  /** "group" or "channel", for labels. */
  const noun = channel ? 'channel' : 'group';
  const Noun = channel ? 'Channel' : 'Group';
  const rights = new Set<string>(group.adminRights);
  const permissions = new Set<string>(group.permissions);
  const { busy, run } = useAsync(onNotice);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(group.title);
  const [description, setDescription] = useState(group.description ?? '');
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [links, setLinks] = useState<InviteLink[] | null>(null);
  /** Phase 15: the new-link form, with admin approval on unless the admin turns it off. */
  const [newLink, setNewLink] = useState<{ approval: boolean } | null>(null);
  const [requests, setRequests] = useState<Array<{ id: string; user: PublicUser; requestedAt: string }> | null>(null);
  const [adding, setAdding] = useState<Peer[] | null>(null);
  const [restricting, setRestricting] = useState<GroupMember | null>(null);
  const [promoting, setPromoting] = useState<GroupMember | null>(null);
  const canEdit = permissions.has('change_info') || rights.has('change_info');
  const canAdd = permissions.has('add_members') || rights.has('invite_users');
  const refresh = useCallback(() => store.refreshChat(chat.id).catch(() => undefined), [store, chat.id]);

  const loadMembers = useCallback(async () => {
    if (!group.canViewMembers) return;
    const page = await listGroupMembers(chat.id);
    setMembers(cast<GroupMember[]>(page.members));
    setNextAfter(page.nextAfter);
  }, [chat.id, group.canViewMembers]);
  const canInvite = rights.has('invite_users');
  const canApprove = rights.has('approve_requests');
  const pendingRequests = group.pendingRequests;
  useEffect(() => {
    void loadMembers().catch(() => undefined);
    if (canInvite) void listInviteLinks(chat.id).then((result) => setLinks(cast<InviteLink[]>(result.links))).catch(() => undefined);
    if (canApprove) void listJoinRequests(chat.id).then((result) => setRequests(cast<Array<{ id: string; user: PublicUser; requestedAt: string }>>(result.requests))).catch(() => undefined);
  }, [chat.id, loadMembers, canInvite, canApprove, pendingRequests]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (await run(() => updateGroup(chat.id, { title: title.trim(), description: description.trim() }), `${Noun} info saved.`)) {
      setEditing(false);
      await refresh();
    }
  }

  async function changePhoto(file: File) {
    await run(async () => {
      const contentType = file.type as 'image/jpeg' | 'image/png' | 'image/webp';
      const upload = await startGroupPhotoUpload(chat.id, { contentType, size: file.size });
      const stored = await fetch(upload.uploadUrl, { method: upload.method, headers: upload.headers, body: file });
      if (!stored.ok) throw new Error('upload failed');
      store.upsertChat(cast<Chat>(await confirmGroupPhoto(chat.id, { uploadId: upload.uploadId })));
    }, `${Noun} picture changed.`);
  }

  const memberItems = (member: GroupMember): MenuItem[] => {
    if (member.user.id === myId || member.role === 'owner') return [];
    const items: MenuItem[] = [];
    if (rights.has('manage_admins')) {
      items.push(
        member.role === 'admin'
          ? { label: 'Edit admin rights', icon: 'manage_accounts', onSelect: () => setPromoting(member) }
          : { label: 'Make admin', icon: 'admin_panel_settings', onSelect: () => setPromoting(member) },
      );
      if (member.role === 'admin') {
        items.push({ label: 'Dismiss as admin', icon: 'person_off', onSelect: () => void run(() => updateGroupMember(chat.id, member.user.id, { role: 'member' }), 'No longer an admin.').then(() => loadMembers()) });
      }
    }
    if (!channel && rights.has('restrict_members') && member.role === 'member') {
      items.push(
        member.deniedPermissions.length > 0
          ? { label: 'Lift restriction', icon: 'lock_reset', onSelect: () => void run(() => updateGroupMember(chat.id, member.user.id, { deniedPermissions: [] }), 'Restriction lifted.').then(() => loadMembers()) }
          : { label: 'Restrict', icon: 'block', onSelect: () => setRestricting(member) },
      );
    }
    if (rights.has('restrict_members') && (member.role === 'member' || member.role === 'subscriber' || rights.has('manage_admins'))) {
      items.push({ label: `Remove from ${noun}`, icon: 'person_remove', danger: true, onSelect: () => void run(() => removeGroupMember(chat.id, member.user.id), `Removed from the ${noun}.`).then(() => loadMembers()) });
    }
    if (group.role === 'owner') {
      items.push({
        label: 'Make owner',
        icon: 'key',
        danger: true,
        onSelect: () => {
          if (window.confirm(`Give the ${noun} to ${member.user.displayName}? You stay an admin.`)) {
            void run(async () => store.upsertChat(cast<Chat>(await transferGroupOwnership(chat.id, { userId: member.user.id }))), 'Ownership transferred.').then(() => loadMembers());
          }
        },
      });
    }
    return items;
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-scrim/30" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={panel} role="dialog" aria-modal="true" aria-label={`${Noun} info`} className="flex h-full w-full max-w-[400px] flex-col overflow-y-auto bg-surface">
        <header className="bedo-glass relative z-10 flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 border-b border-line px-2">
          <button type="button" aria-label={`Close ${noun} info`} onClick={onClose} className="grid size-10 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
            <Icon name="close" />
          </button>
          <h2 className="flex-1 font-medium">{Noun} info</h2>
          {canEdit && !editing ? (
            <button type="button" aria-label={`Edit ${noun}`} onClick={() => setEditing(true)} className="grid size-10 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
              <Icon name="edit" />
            </button>
          ) : null}
        </header>
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <Avatar name={chatTitle(chat)} photoUrl={chatPhoto(chat)} size={96} />
          {canEdit ? (
            <label className="cursor-pointer text-sm text-accent">
              Change picture
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void changePhoto(file);
                  event.target.value = '';
                }}
              />
            </label>
          ) : null}
          {canEdit && group.photoUrl ? (
            <button type="button" className="text-xs text-ink-secondary" onClick={() => void run(async () => store.upsertChat(cast<Chat>(await removeGroupPhoto(chat.id))))}>
              Remove picture
            </button>
          ) : null}
          {editing ? (
            <form className="flex w-full flex-col gap-3 text-left" onSubmit={(event) => void save(event)}>
              <TextField id="edit-group-title" label={`${Noun} name`} value={title} maxLength={GROUP_RULES.titleMaxLength} onChange={(event) => setTitle(event.target.value)} />
              <TextField id="edit-group-description" label="Description" value={description} maxLength={GROUP_RULES.descriptionMaxLength} onChange={(event) => setDescription(event.target.value)} />
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !title.trim()}>
                  Save
                </Button>
                <Button variant="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <>
              <p className="text-[length:var(--bedo-font-size-lg)] font-medium">{group.title}</p>
              <p className="text-sm text-ink-secondary">{groupSubtitle(chat)}</p>
              {group.description ? <p className="whitespace-pre-wrap text-sm">{group.description}</p> : null}
              {channel ? <p className="text-xs text-ink-secondary">{group.public ? 'Public channel' : 'Private channel'}</p> : null}
              {group.restricted ? <p className="text-sm text-danger">The admins restricted what you can do here.</p> : null}
            </>
          )}
        </div>

        {requests && requests.length > 0 ? (
          <section className="border-t border-line px-4 py-3" aria-label="Join requests">
            <h3 className="mb-2 text-sm font-medium">Join requests</h3>
            <ul className="flex flex-col gap-2">
              {requests.map((request) => (
                <li key={request.id} className="flex items-center gap-2">
                  <Avatar name={request.user.displayName} photoUrl={request.user.photoUrl} size={32} />
                  <span className="min-w-0 flex-1 truncate text-sm">{request.user.displayName}</span>
                  <Button className="h-8 px-3" disabled={busy} onClick={() => void run(async () => setRequests(cast<typeof requests>((await approveJoinRequest(chat.id, request.id)).requests))).then(() => loadMembers())}>
                    Approve
                  </Button>
                  <Button variant="secondary" className="h-8 px-3" disabled={busy} onClick={() => void run(async () => setRequests(cast<typeof requests>((await declineJoinRequest(chat.id, request.id)).requests)))}>
                    Decline
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="border-t border-line px-4 py-3" aria-label={channel ? 'Subscribers' : 'Members'}>
          <div className="mb-2 flex items-center">
            <h3 className="flex-1 text-sm font-medium">{channel ? 'Subscribers' : 'Members'}</h3>
            {canAdd ? (
              <button type="button" onClick={() => setAdding([])} className="flex items-center gap-1 text-sm text-accent">
                <Icon name="person_add" size={18} />
                {channel ? 'Add subscribers' : 'Add members'}
              </button>
            ) : null}
          </div>
          {!group.canViewMembers ? (
            <p className="text-sm text-ink-secondary">{channel ? 'Only the admins see who subscribed.' : 'The admins keep the member list private.'}</p>
          ) : members === null ? (
            <p className="text-sm text-ink-secondary">Loading…</p>
          ) : (
            <ul className="flex flex-col">
              {members.map((member) => (
                <li key={member.user.id} className="flex items-center gap-3 py-1.5">
                  <Avatar name={member.user.displayName} photoUrl={member.user.photoUrl} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {member.user.displayName}
                      {member.user.id === myId ? ' (you)' : ''}
                    </span>
                    {member.deniedPermissions.length > 0 ? <span className="block text-xs text-danger">Restricted</span> : null}
                  </span>
                  {ROLE_LABELS[member.role] ? <span className="text-xs text-accent">{ROLE_LABELS[member.role]}</span> : null}
                  {memberItems(member).length > 0 ? <ActionMenu label={`Actions for ${member.user.displayName}`} items={memberItems(member)} /> : null}
                </li>
              ))}
              {nextAfter ? (
                <li>
                  <button
                    type="button"
                    className="py-2 text-sm text-accent"
                    onClick={() =>
                      void listGroupMembers(chat.id, { after: nextAfter }).then((page) => {
                        setMembers([...(members ?? []), ...cast<GroupMember[]>(page.members)]);
                        setNextAfter(page.nextAfter);
                      })
                    }
                  >
                    Show more
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </section>

        {links ? (
          <section className="border-t border-line px-4 py-3" aria-label="Invite links">
            <div className="mb-2 flex items-center">
              <h3 className="flex-1 text-sm font-medium">Invite links</h3>
              {newLink ? null : (
                <button type="button" className="flex items-center gap-1 text-sm font-medium text-accent" onClick={() => setNewLink({ approval: true })}>
                  <Icon name="link" size={18} />
                  New link
                </button>
              )}
            </div>
            {newLink ? (
              <div className="mb-3 flex flex-col gap-3 rounded-md border border-line bg-surface-subtle p-3" aria-label="New invite link">
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4" checked={newLink.approval} onChange={(event) => setNewLink({ approval: event.target.checked })} />
                  <span>
                    <span className="block font-medium">Admins approve each person who joins</span>
                    <span className="block text-xs text-ink-secondary">
                      {newLink.approval ? 'People who open the link send a request; an admin accepts or declines it.' : 'Anyone with the link joins at once.'}
                    </span>
                  </span>
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" className="h-8 px-3" onClick={() => setNewLink(null)}>
                    Cancel
                  </Button>
                  <Button
                    className="h-8 px-3"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        async () => {
                          setLinks([cast<InviteLink>(await createInviteLink(chat.id, { requiresApproval: newLink.approval })), ...(links ?? [])]);
                          setNewLink(null);
                        },
                        newLink.approval ? 'Invite link created: joining needs approval.' : 'Invite link created: anyone with it joins at once.',
                      )
                    }
                  >
                    Create link
                  </Button>
                </div>
              </div>
            ) : null}
            <ul className="flex flex-col gap-2">
              {links.filter((link) => !link.revoked).length === 0 ? <li className="text-sm text-ink-secondary">No active links.</li> : null}
              {links
                .filter((link) => !link.revoked)
                .map((link) => (
                  <li key={link.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{inviteUrl(link.code)}</span>
                      <span className="block text-xs text-ink-secondary">{link.usageCount} joined</span>
                      <label className="mt-1 flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="size-3.5"
                          checked={link.requiresApproval}
                          disabled={busy}
                          aria-label={`Admins approve joins through ${inviteUrl(link.code)}`}
                          onChange={(event) => {
                            const approval = event.target.checked;
                            void run(
                              async () => {
                                const updated = cast<InviteLink>(await updateInviteLink(chat.id, link.id, { requiresApproval: approval }));
                                setLinks((current) => (current ?? []).map((item) => (item.id === updated.id ? updated : item)));
                              },
                              approval ? 'Joining through this link now needs approval.' : 'Anyone with this link now joins at once.',
                            );
                          }}
                        />
                        Admins approve each join
                      </label>
                    </span>
                    <button
                      type="button"
                      aria-label="Copy invite link"
                      onClick={() => void navigator.clipboard.writeText(inviteUrl(link.code)).then(() => onNotice('Link copied.'))}
                      className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
                    >
                      <Icon name="content_copy" size={18} />
                    </button>
                    <button
                      type="button"
                      aria-label="Revoke invite link"
                      onClick={() => void run(async () => setLinks(cast<InviteLink[]>((await revokeInviteLink(chat.id, link.id)).links)), 'Link revoked.')}
                      className="grid size-8 place-items-center rounded-full text-danger transition-colors hover:bg-surface-hover"
                    >
                      <Icon name="link_off" size={18} />
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        {channel && rights.has('change_info') ? (
          <section className="border-t border-line px-4 py-3" aria-label="Channel type">
            <Toggle
              label="Public channel: anyone in the academy can find and join it"
              checked={group.public}
              onChange={(on) => run(async () => store.upsertChat(cast<Chat>(await updateGroupSettings(chat.id, { isPublic: on }))))}
            />
          </section>
        ) : null}

        {group.settings && !channel ? (
          <section className="border-t border-line px-4 py-3" aria-label="Permissions and privacy">
            {rights.has('restrict_members') ? (
              <fieldset className="mb-3 flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">What members can do</legend>
                {MEMBER_PERMISSIONS.map((permission) => (
                  <Toggle
                    key={permission}
                    label={PERMISSION_LABELS[permission]}
                    checked={group.settings!.defaultPermissions.includes(permission)}
                    onChange={(on) =>
                      run(async () =>
                        store.upsertChat(
                          cast<Chat>(
                            await updateGroupSettings(chat.id, {
                              defaultPermissions: on
                                ? [...group.settings!.defaultPermissions.filter((item) => item !== permission), permission]
                                : group.settings!.defaultPermissions.filter((item) => item !== permission),
                            }),
                          ),
                        ),
                      )
                    }
                  />
                ))}
              </fieldset>
            ) : null}
            {rights.has('change_privacy') ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">Member privacy</legend>
                <Toggle
                  label="Hide the member list from members"
                  checked={group.settings.hideMemberList}
                  onChange={(on) => run(async () => store.upsertChat(cast<Chat>(await updateGroupSettings(chat.id, { hideMemberList: on }))))}
                />
                <Toggle
                  label="Hide the member count from members"
                  checked={group.settings.hideMemberCount}
                  onChange={(on) => run(async () => store.upsertChat(cast<Chat>(await updateGroupSettings(chat.id, { hideMemberCount: on }))))}
                />
                <p className="text-xs text-ink-secondary">Owners and admins always see both. Members still see who sends messages.</p>
              </fieldset>
            ) : null}
          </section>
        ) : null}

        <div className="mt-auto flex flex-col gap-2 border-t border-line p-4">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (group.role === 'owner' && (group.memberCount ?? 2) > 1) {
                onNotice(`Make another member the owner first, or delete the ${noun}.`);
                return;
              }
              if (window.confirm(`Leave this ${noun}?`)) {
                void run(() => leaveGroup(chat.id), `You left the ${noun}.`).then((ok) => {
                  if (ok) {
                    store.removeChatLocally(chat.id);
                    onLeft();
                  }
                });
              }
            }}
          >
            Leave {noun}
          </Button>
          {group.role === 'owner' ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete this ${noun} for everyone? ${channel ? 'Subscribers' : 'Members'} can no longer open it.`)) {
                  void run(() => deleteGroup(chat.id), `${Noun} deleted.`).then((ok) => {
                    if (ok) {
                      store.removeChatLocally(chat.id);
                      onLeft();
                    }
                  });
                }
              }}
            >
              Delete {noun}
            </Button>
          ) : null}
        </div>
      </aside>
      {adding ? (
        <Dialog title={channel ? 'Add subscribers' : 'Add members'} onClose={() => setAdding(null)}>
          <div className="flex flex-col gap-3">
            <PeoplePicker picked={adding} onChange={setAdding} exclude={members?.map((member) => member.user.id) ?? []} />
            <Button
              disabled={busy || adding.length === 0}
              onClick={() =>
                void run(async () => {
                  const result = await addGroupMembers(chat.id, { userIds: adding.map((person) => person.id) });
                  onNotice(result.notAdded.length > 0 ? `${result.added.length} added. ${result.notAdded.length} could not be added.` : `${result.added.length} added.`);
                  setAdding(null);
                  await loadMembers();
                  await refresh();
                })
              }
            >
              Add
            </Button>
          </div>
        </Dialog>
      ) : null}
      {restricting ? (
        <RestrictDialog
          member={restricting}
          onClose={() => setRestricting(null)}
          onSave={async (denied, until) => {
            const ok = await run(() => updateGroupMember(chat.id, restricting.user.id, { deniedPermissions: denied, restrictedUntil: until }), 'Member restricted.');
            await loadMembers();
            return ok;
          }}
        />
      ) : null}
      {promoting ? (
        <RightsDialog
          member={promoting}
          type={chat.type}
          allowed={group.adminRights}
          onClose={() => setPromoting(null)}
          onSave={async (adminRights) => {
            const ok = await run(() => updateGroupMember(chat.id, promoting.user.id, { role: 'admin', adminRights }), 'Admin rights saved.');
            await loadMembers();
            return ok;
          }}
        />
      ) : null}
    </div>
  );
}
