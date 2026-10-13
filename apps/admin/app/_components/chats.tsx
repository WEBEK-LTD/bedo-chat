'use client';

import {
  adminAddChatMembers,
  adminCreateChat,
  adminDeleteChat,
  adminGetChat,
  adminListChatMembers,
  adminListChats,
  adminRemoveChatMember,
  adminUpdateChat,
  adminUpdateChatMember,
  type AdminChatDetail,
  type AdminChatMember,
  type AdminChatsResponseChatsItem as ChatItem,
  type AdminUsersResponseUsersItem as UserItem,
} from '@bedo/api-client';
import { adminRightsFor, ADMIN_CONSOLE_RULES, type AdminRight, type MemberPermission, MEMBER_PERMISSIONS } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type FormEvent, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextArea, TextField } from './ui';
import { BackButton, Field, PERMISSION_LABELS, personLabel, ReasonAction, RIGHT_LABELS, SectionTitle, Tabs, UserPicker, useLoader } from './console-ui';

type Filter = 'all' | 'group' | 'channel';

/** D-52: what kind of chat it is, as the admin sees it. */
function kindLabel(chat: { type: string; public: boolean; everyone: boolean }): string {
  if (chat.type !== 'channel') return 'Group';
  return chat.everyone ? 'Channel for everyone' : chat.public ? 'Public channel' : 'Private channel';
}

function countLabel(count: number, type: string): string {
  const word = type === 'channel' ? 'subscriber' : 'member';
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/**
 * Groups and channels (spec §22): every group and channel, its settings, admins and members. Super Admins create
 * them (owned by a user), change settings, add and remove members, set admins and transfer ownership, and delete
 * them. O-18: messages are never shown here; the reported ones are in Reports.
 */
export function Chats({ isSuperAdmin, onSessionError }: { isSuperAdmin: boolean; onSessionError: (error: unknown) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [more, setMore] = useState<ChatItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const params = { ...(search ? { q: search } : {}), ...(filter !== 'all' ? { type: filter } : {}) };
  const { data, error, reload } = useLoader(
    async () => {
      const response = await adminListChats(params);
      setMore([]);
      setCursor(response.nextCursor);
      return response.chats;
    },
    onSessionError,
    [search, filter],
  );

  if (selected) {
    return (
      <ChatDetail
        id={selected}
        isSuperAdmin={isSuperAdmin}
        onSessionError={onSessionError}
        onBack={() => {
          setSelected(null);
          reload();
        }}
      />
    );
  }
  if (creating) {
    return (
      <CreateChat
        onSessionError={onSessionError}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setSelected(id);
        }}
      />
    );
  }

  const chats = data ? [...data, ...more] : null;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionTitle note="Settings, admins and members. Messages are never shown here.">Groups and channels</SectionTitle>
        {isSuperAdmin ? (
          <Button onClick={() => setCreating(true)}>
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Icon name="add" size={20} />
              New group or channel
            </span>
          </Button>
        ) : null}
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setSearch(q.trim());
        }}
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="chats-search" className="text-sm font-medium">
            Search by name
          </label>
          <input
            id="chats-search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>
      <Tabs
        label="Type"
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: 'All' },
          { id: 'group', label: 'Groups' },
          { id: 'channel', label: 'Channels' },
        ]}
      />
      <FormError message={error} />
      {chats === null ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : chats.length === 0 ? (
        <p className="text-sm text-ink-secondary">No groups or channels found.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm" aria-label="Groups and channels">
          {chats.map((chat) => (
            <li key={chat.id}>
              <button type="button" onClick={() => setSelected(chat.id)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-surface-hover">
                <Icon name={chat.type === 'channel' ? 'campaign' : 'groups'} className="text-ink-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {chat.title}
                    {chat.deleted ? <span className="ml-2 text-xs text-danger">Deleted</span> : null}
                  </p>
                  <p className="truncate text-sm text-ink-secondary">
                    {kindLabel(chat)} · {countLabel(chat.memberCount, chat.type)} · owner{' '}
                    {chat.owner?.name ?? '—'}
                  </p>
                </div>
                <span className="hidden text-right text-xs text-ink-secondary sm:inline">Last message {formatDateTime(chat.lastMessageAt)}</span>
                <Icon name="chevron_right" size={20} className="text-ink-secondary" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button
          variant="secondary"
          className="self-start"
          onClick={async () => {
            const response = await adminListChats({ ...params, cursor });
            setMore((list) => [...list, ...response.chats]);
            setCursor(response.nextCursor);
          }}
        >
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function CreateChat({ onCancel, onCreated, onSessionError }: { onCancel: () => void; onCreated: (id: string) => void; onSessionError: (error: unknown) => void }) {
  const [type, setType] = useState<'group' | 'channel'>('group');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  // D-52: a channel made here reaches everyone in the academy unless the admin turns it off.
  const [everyone, setEveryone] = useState(true);
  const [owner, setOwner] = useState<UserItem | null>(null);
  const [members, setMembers] = useState<UserItem[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!owner) return;
    setBusy(true);
    setError(null);
    try {
      const chat = await adminCreateChat({
        type,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ownerUserId: owner.id,
        isPublic: type === 'channel' && isPublic,
        everyone: type === 'channel' && everyone,
        memberIds: type === 'channel' && everyone ? [] : members.map((member) => member.id),
        reason: reason.trim(),
      });
      onCreated(chat.id);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex max-w-xl flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <BackButton label="Groups and channels" onClick={onCancel} />
      <SectionTitle note="A user owns every group and channel; admins are not members of chats.">New group or channel</SectionTitle>
      <Tabs
        label="Kind"
        value={type}
        onChange={setType}
        options={[
          { id: 'group', label: 'Group' },
          { id: 'channel', label: 'Channel' },
        ]}
      />
      <TextField id="chat-title" label="Name" maxLength={128} value={title} onChange={(event) => setTitle(event.target.value)} />
      <TextArea id="chat-description" label="Description (optional)" maxLength={255} value={description} onChange={(event) => setDescription(event.target.value)} />
      {type === 'channel' ? (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={everyone} onChange={(event) => setEveryone(event.target.checked)} />
            <span>
              Everyone in the academy
              <span className="block text-ink-secondary">Every student is a subscriber, and new accounts join it automatically. Only the channel&apos;s admins post.</span>
            </span>
          </label>
          {everyone ? null : (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
              Public channel (anyone in the academy can find and join it)
            </label>
          )}
        </>
      ) : null}
      {owner ? (
        <p className="flex items-center gap-2 text-sm">
          <span className="text-ink-secondary">Owner:</span> {personLabel(owner)}
          <button type="button" className="text-accent" onClick={() => setOwner(null)}>
            Change
          </button>
        </p>
      ) : (
        <UserPicker id="chat-owner" label="Owner" onPick={setOwner} />
      )}
      {type === 'channel' && everyone ? null : (
        <UserPicker id="chat-members" label={type === 'channel' ? 'Add subscribers' : 'Add members'} exclude={[...(owner ? [owner.id] : []), ...members.map((member) => member.id)]} onPick={(user) => setMembers((list) => [...list, user])} />
      )}
      {members.length > 0 && !(type === 'channel' && everyone) ? (
        <ul className="flex flex-wrap gap-2 text-sm" aria-label="Chosen members">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-1 rounded-sm bg-surface-subtle px-2 py-1">
              {member.name ?? member.phone}
              <button type="button" aria-label={`Remove ${member.name ?? member.phone}`} onClick={() => setMembers((list) => list.filter((item) => item.id !== member.id))}>
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <TextArea id="chat-reason" label="Reason (kept in the admin history)" maxLength={ADMIN_CONSOLE_RULES.reasonMaxLength} value={reason} onChange={(event) => setReason(event.target.value)} />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" busy={busy} disabled={!owner || !title.trim() || reason.trim().length < ADMIN_CONSOLE_RULES.reasonMinLength}>
          Create {type}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ChatDetail({ id, isSuperAdmin, onBack, onSessionError }: { id: string; isSuperAdmin: boolean; onBack: () => void; onSessionError: (error: unknown) => void }) {
  const { data: chat, setData, error } = useLoader(() => adminGetChat(id), onSessionError, [id]);
  const members = useLoader(() => adminListChatMembers(id), onSessionError, [id]);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const refreshMembers = () => members.reload();
  async function run<T>(work: () => Promise<T>, message: string): Promise<T> {
    try {
      const result = await work();
      setDone(message);
      return result;
    } catch (caught) {
      onSessionError(caught);
      throw caught;
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <BackButton label="Groups and channels" onClick={onBack} />
      <FormError message={error} />
      {!chat ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">{chat.title}</h1>
            <p className="text-sm text-ink-secondary">
              {kindLabel(chat)} · {countLabel(chat.memberCount, chat.type)}
              {chat.deleted ? ' · Deleted' : ''}
            </p>
          </header>
          {done ? <Notice>{done}</Notice> : null}
          <section className="grid gap-x-6 gap-y-2 rounded-md border border-line bg-surface shadow-sm p-4 text-sm md:grid-cols-2" aria-label="Details">
            <Field label="Owner">{personLabel(chat.owner)}</Field>
            <Field label="Created">{formatDateTime(chat.createdAt)}</Field>
            <Field label="Last message">{formatDateTime(chat.lastMessageAt)}</Field>
            {chat.type === 'channel' ? <Field label="Subscribers">{chat.everyone ? 'Everyone in the academy, new accounts too' : 'People added or who joined'}</Field> : null}
            {chat.type === 'group' ? (
              <>
                <Field label="Members may">{chat.settings.defaultPermissions.map((permission) => PERMISSION_LABELS[permission as MemberPermission].toLowerCase()).join(', ') || 'only read'}</Field>
                <Field label="Member list">{chat.settings.hideMemberList ? 'Admins only' : 'Everyone'}</Field>
                <Field label="Member count">{chat.settings.hideMemberCount ? 'Admins only' : 'Everyone'}</Field>
              </>
            ) : null}
            {chat.description ? (
              <p className="md:col-span-2">
                <span className="text-ink-secondary">Description: </span>
                {chat.description}
              </p>
            ) : null}
          </section>

          {isSuperAdmin && !chat.deleted ? <ChatSettings
              chat={chat}
              onSaved={(next) => {
                setData(next);
                refreshMembers();
              }}
              run={run}
            /> : null}

          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">{chat.type === 'channel' ? 'Subscribers and admins' : 'Members and admins'}</h2>
            {isSuperAdmin && !chat.deleted ? (
              <AddMembers
                chatId={id}
                exclude={(members.data?.members ?? []).map((member) => member.user.id)}
                run={async (userIds, reason) => {
                  const result = await run(() => adminAddChatMembers(id, { userIds, reason }), 'Added.');
                  refreshMembers();
                  setData(await adminGetChat(id));
                  return result;
                }}
              />
            ) : null}
            <FormError message={members.error} />
            {!members.data ? (
              <p className="text-sm text-ink-secondary">Loading…</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm" aria-label="Members">
                {members.data.members.map((member) => (
                  <li key={member.user.id} className="flex flex-col gap-2 px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{personLabel(member.user)}</p>
                        <p className="text-xs text-ink-secondary">
                          {member.role === 'owner' ? 'Owner' : member.role === 'admin' ? `Admin: ${member.adminRights.map((right) => RIGHT_LABELS[right as AdminRight]).join(', ') || 'no rights'}` : member.role === 'subscriber' ? 'Subscriber' : 'Member'}
                          {member.deniedPermissions.length > 0 ? ` · restricted: ${member.deniedPermissions.map((permission) => PERMISSION_LABELS[permission as MemberPermission].toLowerCase()).join(', ')}` : ''}
                          {member.restrictedUntil ? ` until ${formatDateTime(member.restrictedUntil)}` : ''} · joined {formatDateTime(member.joinedAt)}
                        </p>
                      </div>
                      {isSuperAdmin && !chat.deleted && member.role !== 'owner' ? (
                        <Button variant="ghost" onClick={() => setEditing(editing === member.user.id ? null : member.user.id)} aria-expanded={editing === member.user.id}>
                          {editing === member.user.id ? 'Close' : 'Manage'}
                        </Button>
                      ) : null}
                    </div>
                    {editing === member.user.id ? (
                      <MemberEditor
                        chat={chat}
                        member={member}
                        onChanged={async (message) => {
                          setDone(message);
                          setEditing(null);
                          refreshMembers();
                          setData(await adminGetChat(id));
                        }}
                        onSessionError={onSessionError}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {isSuperAdmin && !chat.deleted ? (
            <section className="flex flex-col gap-3 border-t border-line pt-6">
              <h2 className="font-semibold">Delete {chat.type}</h2>
              <div className="flex">
              <ReasonAction
                id="delete-chat"
                label={`Delete ${chat.type}`}
                danger
                confirmText={`Delete this ${chat.type}? It disappears for every member. Its history is kept for investigations.`}
                confirmLabel="Delete permanently"
                onConfirm={async (reason) => setData(await run(() => adminDeleteChat(id, { reason }), `The ${chat.type} is deleted.`))}
              />
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function ChatSettings({ chat, onSaved, run }: { chat: AdminChatDetail; onSaved: (chat: AdminChatDetail) => void; run: <T>(work: () => Promise<T>, message: string) => Promise<T> }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [description, setDescription] = useState(chat.description ?? '');
  const [isPublic, setIsPublic] = useState(chat.public);
  const [everyone, setEveryone] = useState(chat.everyone);
  const [permissions, setPermissions] = useState<MemberPermission[]>(chat.settings.defaultPermissions as MemberPermission[]);
  const [hideList, setHideList] = useState(chat.settings.hideMemberList);
  const [hideCount, setHideCount] = useState(chat.settings.hideMemberCount);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>
        Edit settings
      </Button>
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...(title.trim() !== chat.title ? { title: title.trim() } : {}),
        ...(description.trim() !== (chat.description ?? '') ? { description: description.trim() } : {}),
        ...(chat.type === 'channel' && isPublic !== chat.public ? { isPublic } : {}),
        ...(chat.type === 'channel' && everyone !== chat.everyone ? { everyone } : {}),
        ...(chat.type === 'group'
          ? {
              ...(permissions.join() !== chat.settings.defaultPermissions.join() ? { defaultPermissions: permissions } : {}),
              ...(hideList !== chat.settings.hideMemberList ? { hideMemberList: hideList } : {}),
              ...(hideCount !== chat.settings.hideMemberCount ? { hideMemberCount: hideCount } : {}),
            }
          : {}),
        reason: reason.trim(),
      };
      if (Object.keys(body).length === 1) {
        setOpen(false);
        return;
      }
      onSaved(await run(() => adminUpdateChat(chat.id, body), 'Settings saved.'));
      setOpen(false);
      setReason('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flex max-w-xl flex-col gap-3 rounded-md border border-line bg-surface shadow-sm p-4" onSubmit={(event) => void save(event)} aria-label="Settings">
      <h2 className="font-semibold">Settings</h2>
      <TextField id="edit-title" label="Name" maxLength={128} value={title} onChange={(event) => setTitle(event.target.value)} />
      <TextArea id="edit-description" label="Description" maxLength={255} value={description} onChange={(event) => setDescription(event.target.value)} />
      {chat.type === 'channel' ? (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={everyone} onChange={(event) => setEveryone(event.target.checked)} />
            <span>
              Everyone in the academy
              <span className="block text-ink-secondary">
                {chat.everyone
                  ? 'Turning it off removes nobody; new accounts just stop joining it.'
                  : 'Adds every student now, and new accounts join it automatically. People who left or were removed are not added back.'}
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} />
            Public channel
          </label>
        </>
      ) : (
        <>
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 font-medium">What members may do</legend>
            {MEMBER_PERMISSIONS.map((permission) => (
              <label key={permission} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={permissions.includes(permission)}
                  onChange={(event) => setPermissions((list) => (event.target.checked ? MEMBER_PERMISSIONS.filter((item) => item === permission || list.includes(item)) : list.filter((item) => item !== permission)))}
                />
                {PERMISSION_LABELS[permission]}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hideList} onChange={(event) => setHideList(event.target.checked)} />
            Only admins see the member list
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={hideCount} onChange={(event) => setHideCount(event.target.checked)} />
            Only admins see the member count
          </label>
        </>
      )}
      <TextArea id="edit-reason" label="Reason (kept in the admin history)" maxLength={ADMIN_CONSOLE_RULES.reasonMaxLength} value={reason} onChange={(event) => setReason(event.target.value)} />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" busy={busy} disabled={reason.trim().length < ADMIN_CONSOLE_RULES.reasonMinLength || !title.trim()}>
          Save settings
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddMembers({ chatId, exclude, run }: { chatId: string; exclude: string[]; run: (userIds: string[], reason: string) => Promise<unknown> }) {
  const [chosen, setChosen] = useState<UserItem[]>([]);
  if (chosen.length === 0) {
    return <UserPicker id={`add-${chatId}`} label="Add people" exclude={exclude} onPick={(user) => setChosen([user])} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <UserPicker id={`add-${chatId}`} label="Add people" exclude={[...exclude, ...chosen.map((user) => user.id)]} onPick={(user) => setChosen((list) => [...list, user])} />
      <p className="text-sm">
        <span className="text-ink-secondary">To add: </span>
        {chosen.map((user) => user.name ?? user.phone).join(', ')}
      </p>
      <div className="flex gap-2">
        <ReasonAction
          id="add-members"
          label={`Add ${chosen.length}`}
          confirmText="Add these people? They see the chat on their devices at once. A ban on any of them is lifted."
          onConfirm={async (reason) => {
            await run(
              chosen.map((user) => user.id),
              reason,
            );
            setChosen([]);
          }}
        />
        <Button variant="secondary" onClick={() => setChosen([])}>
          Clear
        </Button>
      </div>
    </div>
  );
}

function MemberEditor({ chat, member, onChanged, onSessionError }: { chat: AdminChatDetail; member: AdminChatMember; onChanged: (message: string) => Promise<void>; onSessionError: (error: unknown) => void }) {
  const rights = adminRightsFor(chat.type);
  const [role, setRole] = useState<'admin' | 'member'>(member.role === 'admin' ? 'admin' : 'member');
  const [chosenRights, setChosenRights] = useState<AdminRight[]>(member.adminRights as AdminRight[]);
  const [denied, setDenied] = useState<MemberPermission[]>(member.deniedPermissions as MemberPermission[]);
  const [error, setError] = useState<string | null>(null);
  const name = member.user.name ?? member.user.phone ?? 'this person';

  async function apply(body: Parameters<typeof adminUpdateChatMember>[2], message: string) {
    try {
      await adminUpdateChatMember(chat.id, member.user.id, body);
      await onChanged(message);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
      throw caught;
    }
  }

  const memberWord = chat.type === 'channel' ? 'subscriber' : 'member';
  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface-subtle p-3" aria-label={`Manage ${name}`}>
      <Tabs
        label="Role"
        value={role}
        onChange={setRole}
        options={[
          { id: 'member', label: chat.type === 'channel' ? 'Subscriber' : 'Member' },
          { id: 'admin', label: 'Admin' },
        ]}
      />
      {role === 'admin' ? (
        <fieldset className="grid gap-1 text-sm sm:grid-cols-2">
          <legend className="mb-1 font-medium">Admin rights</legend>
          {rights.map((right) => (
            <label key={right} className="flex items-center gap-2">
              <input type="checkbox" checked={chosenRights.includes(right)} onChange={(event) => setChosenRights((list) => (event.target.checked ? [...list, right] : list.filter((item) => item !== right)))} />
              {RIGHT_LABELS[right]}
            </label>
          ))}
        </fieldset>
      ) : chat.type === 'group' ? (
        <fieldset className="grid gap-1 text-sm sm:grid-cols-2">
          <legend className="mb-1 font-medium">Restrict (turned on = not allowed)</legend>
          {MEMBER_PERMISSIONS.map((permission) => (
            <label key={permission} className="flex items-center gap-2">
              <input type="checkbox" checked={denied.includes(permission)} onChange={(event) => setDenied((list) => (event.target.checked ? [...list, permission] : list.filter((item) => item !== permission)))} />
              {PERMISSION_LABELS[permission]}
            </label>
          ))}
        </fieldset>
      ) : null}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <ReasonAction
          id={`save-${member.user.id}`}
          label="Save"
          confirmText={role === 'admin' ? `Make ${name} an admin with the chosen rights?` : `Save ${name} as a ${memberWord}${chat.type === 'group' && denied.length > 0 ? ' with these restrictions' : ''}?`}
          onConfirm={(reason) =>
            apply(
              role === 'admin'
                ? { role: 'admin', adminRights: chosenRights, reason }
                : { ...(member.role === 'admin' ? { role: 'member' as const } : {}), ...(chat.type === 'group' ? { deniedPermissions: denied, restrictedUntil: null } : {}), reason },
              'Saved.',
            )
          }
        />
        <ReasonAction
          id={`owner-${member.user.id}`}
          label="Make owner"
          danger
          confirmText={`Transfer ownership to ${name}? The current owner becomes an admin with every right.`}
          onConfirm={(reason) => apply({ role: 'owner', reason }, `${name} is the owner now.`)}
        />
        <ReasonAction
          id={`remove-${member.user.id}`}
          label="Remove"
          danger
          confirmText={`Remove ${name}? They are banned from rejoining until an admin adds them again.`}
          onConfirm={async (reason) => {
            try {
              await adminRemoveChatMember(chat.id, member.user.id, { reason });
              await onChanged(`${name} was removed.`);
            } catch (caught) {
              onSessionError(caught);
              throw caught;
            }
          }}
        />
      </div>
    </div>
  );
}
