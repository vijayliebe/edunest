import { useMemo, useState } from 'react'
import { api, type AdminCourse, type AppUser } from '../api'
import { useAuth } from '../auth'
import { useLoad } from '../util'

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('')
}

/** Admin panel: add/remove users and decide which courses each non-admin can see. */
export default function UsersAccess() {
  const me = useAuth().user
  const users = useLoad(() => api.users(), [])
  const courses = useLoad(() => api.adminCourses(), [])
  const [open, setOpen] = useState<string | null>(null)

  return (
    <section id="users" className="mt-10 scroll-mt-20">
      <h2 className="text-lg font-semibold">Users & access</h2>
      <p className="text-sm text-muted">
        Each user has their own progress and notes. Admins (set in docker-compose) see every course; for everyone else you choose
        which courses they can see. New users see nothing until you grant access.
      </p>

      <AddUser
        onAdded={(u) => {
          users.setData((cur) => [...(cur ?? []), u])
          setOpen(u.username)
        }}
      />

      {users.error && <p className="mt-3 text-sm text-red-400">{users.error}</p>}
      <ul className="mt-4 space-y-3">
        {users.data?.map((u) => (
          <UserRow
            key={u.username}
            user={u}
            isMe={u.username === me.username}
            courses={courses.data ?? []}
            open={open === u.username}
            onToggle={() => setOpen(open === u.username ? null : u.username)}
            onChange={(nu) => users.setData((cur) => (cur ?? []).map((x) => (x.username === nu.username ? nu : x)))}
            onDeleted={() => users.setData((cur) => (cur ?? []).filter((x) => x.username !== u.username))}
          />
        ))}
      </ul>
    </section>
  )
}

function AddUser({ onAdded }: { onAdded: (u: AppUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="mt-4 rounded-xl border border-line bg-panel p-4">
      <p className="text-sm font-medium">Add a user</p>
      <form
        className="mt-2 flex flex-wrap items-start gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setErr(null)
          try {
            const u = await api.createUser(username.trim(), password)
            setCreated({ username: u.username, password })
            setUsername('')
            setPassword('')
            onAdded(u)
          } catch (e2) {
            setErr((e2 as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-40 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <div className="flex">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type={show ? 'text' : 'password'}
            placeholder="password (min 8)"
            autoComplete="new-password"
            className="w-48 rounded-l-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            title="Generate a strong password"
            onClick={() => {
              setPassword(randomPassword())
              setShow(true)
            }}
            className="rounded-r-lg border border-l-0 border-line bg-panel-2 px-2 text-xs text-muted hover:text-white"
          >
            Generate
          </button>
        </div>
        <button
          disabled={busy || !username.trim() || password.length < 8}
          className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
        >
          {busy ? 'Adding…' : 'Add user'}
        </button>
      </form>
      {err && <p className="mt-2 text-sm text-red-400">{err}</p>}
      {created && (
        <p className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Added <b>{created.username}</b>. Share the password with them now — it isn't shown again:{' '}
          <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-white">{created.password}</code>
          <button onClick={() => setCreated(null)} className="ml-2 text-xs text-muted hover:text-white">dismiss</button>
        </p>
      )}
    </div>
  )
}

function UserRow({
  user,
  isMe,
  courses,
  open,
  onToggle,
  onChange,
  onDeleted,
}: {
  user: AppUser
  isMe: boolean
  courses: AdminCourse[]
  open: boolean
  onToggle: () => void
  onChange: (u: AppUser) => void
  onDeleted: () => void
}) {
  const [err, setErr] = useState<string | null>(null)
  const summary = user.is_admin
    ? 'All courses (admin)'
    : user.mode === 'all'
      ? 'All courses'
      : `${user.course_ids?.length ?? 0} of ${courses.length} courses`

  return (
    <li className="rounded-xl border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-bold uppercase">{user.username[0]}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {user.username} {isMe && <span className="text-xs font-normal text-muted">(you)</span>}
          </p>
          <p className="text-xs text-muted">
            {user.is_admin ? 'Admin · from docker-compose' : user.source === 'app' ? 'User · added in Settings' : 'User · from docker-compose'}
            {' · '}
            <span className={!user.is_admin && user.mode !== 'all' && !user.course_ids?.length ? 'text-amber-300' : ''}>{summary}</span>
          </p>
        </div>
        {!user.is_admin && (
          <button onClick={onToggle} className="rounded-full border border-line px-3 py-1 text-sm hover:bg-white/10">
            {open ? 'Close' : 'Course access'}
          </button>
        )}
        {user.source === 'app' && (
          <>
            <button
              onClick={async () => {
                const pw = prompt(`New password for ${user.username} (min 8 characters). They will be signed out everywhere.`, randomPassword())
                if (!pw) return
                setErr(null)
                try {
                  await api.resetPassword(user.username, pw)
                  alert(`Password changed. New password for ${user.username}:\n\n${pw}`)
                } catch (e) {
                  setErr((e as Error).message)
                }
              }}
              className="rounded-full px-3 py-1 text-sm text-muted hover:bg-white/10 hover:text-white"
            >
              Reset password
            </button>
            <button
              onClick={async () => {
                if (!confirm(`Delete user "${user.username}"?\n\nThey are signed out immediately and their progress and notes are deleted. This can't be undone.`)) return
                setErr(null)
                try {
                  await api.deleteUser(user.username)
                  onDeleted()
                } catch (e) {
                  setErr((e as Error).message)
                }
              }}
              className="rounded-full px-3 py-1 text-sm text-muted hover:bg-red-500/20 hover:text-red-300"
            >
              Delete
            </button>
          </>
        )}
      </div>
      {err && <p className="px-4 pb-3 text-sm text-red-400">{err}</p>}
      {open && !user.is_admin && <AccessEditor user={user} courses={courses} onSaved={onChange} />}
    </li>
  )
}

function AccessEditor({ user, courses, onSaved }: { user: AppUser; courses: AdminCourse[]; onSaved: (u: AppUser) => void }) {
  const [mode, setMode] = useState<'all' | 'selected'>(user.mode ?? 'selected')
  const [selected, setSelected] = useState<Set<number>>(new Set(user.course_ids ?? []))
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const shown = useMemo(
    () => courses.filter((c) => !filter || c.title.toLowerCase().includes(filter.toLowerCase()) || c.library?.toLowerCase().includes(filter.toLowerCase())),
    [courses, filter],
  )
  const dirty = mode !== (user.mode ?? 'selected') || selected.size !== (user.course_ids?.length ?? 0) || (user.course_ids ?? []).some((id) => !selected.has(id))

  return (
    <div className="border-t border-line p-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ['all', 'All courses', 'Including courses added later'],
            ['selected', 'Selected courses only', 'Pick the courses below'],
          ] as const
        ).map(([v, label, hint]) => (
          <label key={v} className={`cursor-pointer rounded-lg border p-3 text-sm ${mode === v ? 'border-accent bg-accent/10' : 'border-line'}`}>
            <input type="radio" className="mr-2" checked={mode === v} onChange={() => setMode(v)} />
            <span className="font-medium">{label}</span>
            <span className="block pl-5 text-xs text-muted">{hint}</span>
          </label>
        ))}
      </div>

      {mode === 'selected' && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter courses"
              className="flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button onClick={() => setSelected(new Set([...selected, ...shown.map((c) => c.id)]))} className="rounded px-2 py-1 text-xs text-muted hover:bg-white/10 hover:text-white">
              Select shown
            </button>
            <button
              onClick={() => {
                const s = new Set(selected)
                shown.forEach((c) => s.delete(c.id))
                setSelected(s)
              }}
              className="rounded px-2 py-1 text-xs text-muted hover:bg-white/10 hover:text-white"
            >
              Clear shown
            </button>
          </div>
          <ul className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-line">
            {shown.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={(e) => {
                      const s = new Set(selected)
                      if (e.target.checked) s.add(c.id)
                      else s.delete(c.id)
                      setSelected(s)
                    }}
                  />
                  <span className="flex-1">{c.title}</span>
                  <span className="text-xs text-muted">
                    {c.library ? `${c.library} · ` : ''}
                    {c.lesson_count} lessons
                  </span>
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-3 text-sm text-muted">No courses.</li>}
          </ul>
          <p className="mt-1 text-xs text-muted">{selected.size} selected</p>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-3">
        {msg && <span className="text-sm text-emerald-300">{msg}</span>}
        <button
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true)
            setMsg(null)
            try {
              onSaved(await api.setAccess(user.username, mode, [...selected]))
              setMsg('Saved')
            } finally {
              setBusy(false)
            }
          }}
          className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save access'}
        </button>
      </div>
    </div>
  )
}
