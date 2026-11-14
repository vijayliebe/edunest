import { useEffect, useState } from 'react'
import { api, type Library } from '../api'
import { useAuth } from '../auth'
import { useLayout } from '../components/Layout'
import UsersAccess from '../components/UsersAccess'
import { useLoad } from '../util'

const MODES: { value: Library['mode']; label: string; hint: string }[] = [
  { value: 'collection', label: 'Folder of courses', hint: 'Each sub-folder is a course' },
  { value: 'course', label: 'Single course', hint: 'This folder itself is one course' },
]

export default function Settings() {
  const { user } = useAuth()
  if (!user.is_admin) return <p className="mx-auto max-w-3xl px-6 py-12 text-muted">Settings are only available to admins.</p>
  return <AdminSettings />
}

function AdminSettings() {
  const { scan, startScan, scanVersion } = useLayout()
  const libs = useLoad(() => api.libraries(), [scanVersion])
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = async (fn: () => Promise<Library[]>) => {
    setErr(null)
    try {
      libs.setData(await fn())
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <section className="mt-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Library folders</h2>
            <p className="text-sm text-muted">
              Folders EduNest reads videos from. Paths are inside the container — mount each NAS folder as a volume (read-only is fine).
            </p>
          </div>
          {!adding && (
            <button onClick={() => setAdding(true)} className="shrink-0 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black hover:bg-white/90">
              + Add folder
            </button>
          )}
        </div>

        {err && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</p>}

        {adding && (
          <AddLibrary
            onCancel={() => setAdding(false)}
            onAdd={async (path, mode) => {
              await run(() => api.addLibrary(path, mode))
              setAdding(false)
            }}
          />
        )}

        <ul className="mt-4 space-y-3">
          {libs.data?.map((lb) => (
            <li key={lb.id} className={`rounded-xl border border-line bg-panel p-4 ${lb.enabled ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-semibold">
                    {lb.name}
                    <button
                      onClick={() => {
                        const name = prompt('Library name:', lb.name)
                        if (name?.trim() && name.trim() !== lb.name) void run(() => api.updateLibrary(lb.id, { name: name.trim() }))
                      }}
                      title="Rename"
                      className="rounded px-1 text-xs font-normal text-muted hover:bg-white/10 hover:text-white"
                    >
                      ✎ rename
                    </button>
                  </p>
                  <p className="break-all font-mono text-xs text-muted">{lb.path}</p>
                  <p className="mt-1 text-xs">
                    {lb.exists ? (
                      <span className="text-emerald-400">{lb.course_count} course{lb.course_count === 1 ? '' : 's'}</span>
                    ) : (
                      <span className="text-red-400">Folder not found — is the volume mounted?</span>
                    )}
                  </p>
                </div>
                <select
                  value={lb.mode}
                  onChange={(e) => void run(() => api.updateLibrary(lb.id, { mode: e.target.value as Library['mode'] }))}
                  className="rounded-lg border border-line bg-panel-2 px-2 py-1 text-sm"
                >
                  {MODES.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={lb.enabled}
                    onChange={(e) => void run(() => api.updateLibrary(lb.id, { enabled: e.target.checked }))}
                  />
                  Enabled
                </label>
                <button
                  onClick={() => {
                    if (confirm(`Remove "${lb.name}" from the library?\n\nYour video files are not touched. Notes and progress are kept and come back if you add the folder again.`))
                      void run(() => api.deleteLibrary(lb.id))
                  }}
                  className="rounded-full px-3 py-1 text-sm text-muted hover:bg-red-500/20 hover:text-red-300"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
          {libs.data?.length === 0 && <li className="rounded-xl border border-dashed border-line p-6 text-center text-muted">No folders yet.</li>}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Scanning</h2>
        <p className="text-sm text-muted">
          EduNest scans on startup, every 15 minutes, and when folders change here, so new downloads show up on their own. A full rescan re-reads metadata for every file.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button disabled={scan?.running} onClick={() => void startScan()} className="rounded-full border border-line px-4 py-1.5 text-sm hover:bg-white/10 disabled:opacity-40">
            Rescan now
          </button>
          <button disabled={scan?.running} onClick={() => void startScan(true)} className="rounded-full border border-line px-4 py-1.5 text-sm hover:bg-white/10 disabled:opacity-40">
            Full rescan
          </button>
          {scan && (
            <span className="text-sm text-muted">
              {scan.running
                ? `Scanning… ${scan.processed}/${scan.total}`
                : scan.finished_at
                  ? `Last scan ${new Date(scan.finished_at).toLocaleString()}: ${scan.added} added, ${scan.updated} updated, ${scan.relinked} relinked, ${scan.missing} missing`
                  : ''}
            </span>
          )}
        </div>
        {scan?.error && <p className="mt-2 text-sm text-red-400">{scan.error}</p>}
        {scan?.errors?.map((e) => (
          <p key={e} className="mt-1 text-sm text-amber-300">{e}</p>
        ))}
      </section>

      <UsersAccess />

      <SecuritySection />
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  login_ok: 'Signed in',
  login_failed: 'Failed login',
  login_throttled: 'Blocked (too many failures)',
  unauthorized: 'Access without login',
  forbidden: 'Non-admin tried admin page',
  bad_origin: 'Cross-site request blocked',
  user_created: 'User added',
  user_deleted: 'User deleted',
  password_reset: 'Password reset',
}

function SecuritySection() {
  const summary = useLoad(() => api.securitySummary(), [])
  const events = useLoad(() => api.securityEvents(100), [])
  const [onlySuspicious, setOnlySuspicious] = useState(true)

  useEffect(() => {
    if (window.location.hash === '#security') document.getElementById('security')?.scrollIntoView()
  }, [summary.data])

  const s = summary.data
  const list = (events.data ?? []).filter((e) => !onlySuspicious || e.kind !== 'login_ok')
  const n = (k: string, period: 'last_24h' | 'last_7d' = 'last_24h') => s?.[period][k] ?? 0

  return (
    <section id="security" className="mt-10 scroll-mt-20">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Security</h2>
          <p className="text-sm text-muted">Login attempts and requests made without permission. Repeats from the same address are grouped per minute.</p>
        </div>
        <button
          onClick={() => {
            void summary.reload()
            void events.reload()
          }}
          className="shrink-0 rounded-full border border-line px-3 py-1 text-sm hover:bg-white/10"
        >
          Refresh
        </button>
      </div>

      {s && (
        <div className={`mt-4 rounded-xl border p-4 ${s.alert ? 'border-red-500/50 bg-red-500/10' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
          {s.alert ? (
            <>
              <p className="font-semibold text-red-300">⚠ Suspicious activity in the last 24 hours</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-red-200">
                {s.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
              <p className="mt-2 text-xs text-red-200/80">
                If this keeps happening, consider turning off public access (port forwarding / tunnel) for a while.
                Failed logins are slowed down automatically, so guessing passwords stays impractical.
              </p>
            </>
          ) : (
            <p className="text-sm text-emerald-300">✓ Nothing unusual in the last 24 hours.</p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <Stat label="Failed logins" a={n('login_failed')} b={n('login_failed', 'last_7d')} />
            <Stat label="Blocked" a={n('login_throttled')} b={n('login_throttled', 'last_7d')} />
            <Stat label="No-login access" a={n('unauthorized')} b={n('unauthorized', 'last_7d')} />
            <Stat label="Successful logins" a={n('login_ok')} b={n('login_ok', 'last_7d')} />
          </div>
          {s.top_ips.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Most active addresses (7 days):{' '}
              {s.top_ips.map((t) => `${t.ip} (${t.n})`).join(', ')}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={onlySuspicious} onChange={(e) => setOnlySuspicious(e.target.checked)} />
          Hide successful logins
        </label>
        <button
          onClick={async () => {
            if (!confirm('Clear the whole security log?')) return
            await api.clearSecurityEvents()
            void summary.reload()
            void events.reload()
          }}
          className="ml-auto rounded-full px-3 py-1 text-muted hover:bg-white/10 hover:text-white"
        >
          Clear log
        </button>
      </div>

      <div className="mt-2 overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-panel-2 text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When (UTC)</th>
              <th className="px-3 py-2 font-medium">What</th>
              <th className="px-3 py-2 font-medium">Address</th>
              <th className="px-3 py-2 font-medium">User / path</th>
              <th className="px-3 py-2 text-right font-medium">Times</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((e) => (
              <tr key={e.id} className={e.kind === 'login_ok' ? 'text-muted' : ''}>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{e.at}</td>
                <td className={`px-3 py-2 ${['login_ok', 'user_created', 'user_deleted', 'password_reset'].includes(e.kind) ? '' : 'text-amber-300'}`}>{KIND_LABEL[e.kind] ?? e.kind}</td>
                <td className="px-3 py-2 font-mono text-xs">{e.ip}</td>
                <td className="max-w-56 truncate px-3 py-2 font-mono text-xs" title={e.path ?? ''}>{e.username ?? e.path ?? ''}</td>
                <td className="px-3 py-2 text-right">{e.count}</td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">No events.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Stat({ label, a, b }: { label: string; a: number; b: number }) {
  return (
    <div className="rounded-lg bg-bg/50 px-3 py-2">
      <div className="text-lg font-semibold">{a}</div>
      <div className="text-xs text-muted">{label} · {b} in 7 days</div>
    </div>
  )
}

function AddLibrary({ onAdd, onCancel }: { onAdd: (path: string, mode: Library['mode']) => Promise<void>; onCancel: () => void }) {
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<Library['mode']>('collection')
  const [browsing, setBrowsing] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const dir = useLoad(() => api.browse(browsing), [browsing])
  const mounts = useLoad(() => api.mounts(), [])
  const available = mounts.data?.filter((m) => !m.is_library) ?? []

  return (
    <div className="mt-4 rounded-xl border border-accent/40 bg-panel p-4">
      {mounts.data && (
        <div className="mb-4">
          <p className="text-sm font-medium">Folders mounted into the container</p>
          {available.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {available.map((m) => (
                <button
                  key={m.path}
                  onClick={() => {
                    setPath(m.path)
                    setBrowsing(m.path)
                    setMode(m.suggested_mode)
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-left text-sm hover:border-accent ${path === m.path ? 'border-accent bg-accent/15' : 'border-line bg-panel-2'}`}
                >
                  📁 {m.name || m.path}
                  <span className="block font-mono text-[11px] text-muted">{m.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {mounts.data.length
                ? 'All mounted folders are already libraries.'
                : 'No shared folders detected. Add a volume like /volume1/Videos/DL:/media/dl:ro to the container, redeploy, then come back.'}
            </p>
          )}
        </div>
      )}
      <label className="text-sm font-medium">Folder path <span className="font-normal text-muted">(or a sub-folder of a mount)</span></label>
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="/media/deep-learning"
        className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm outline-none focus:border-accent"
      />

      <div className="mt-3 overflow-hidden rounded-lg border border-line">
        <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-2 text-xs">
          <button disabled={!dir.data?.parent} onClick={() => setBrowsing(dir.data?.parent ?? undefined)} className="rounded px-2 py-0.5 hover:bg-white/10 disabled:opacity-30">
            ↑ Up
          </button>
          <span className="truncate font-mono text-muted">{dir.data?.path}</span>
          <button onClick={() => dir.data && setPath(dir.data.path)} className="ml-auto shrink-0 rounded bg-accent px-2 py-0.5 font-semibold text-white hover:brightness-110">
            Use this folder
          </button>
        </div>
        <ul className="max-h-56 overflow-y-auto text-sm">
          {dir.error && <li className="px-3 py-2 text-red-400">{dir.error}</li>}
          {dir.data?.dirs.map((d) => {
            const full = `${dir.data!.path.replace(/\/$/, '')}/${d}`
            return (
              <li key={d}>
                <button onClick={() => setBrowsing(full)} onDoubleClick={() => setPath(full)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 ${path === full ? 'bg-accent/15' : ''}`}>
                  📁 {d}
                </button>
              </li>
            )
          })}
          {dir.data && dir.data.dirs.length === 0 && <li className="px-3 py-2 text-muted">No sub-folders</li>}
        </ul>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {MODES.map((m) => (
          <label key={m.value} className={`cursor-pointer rounded-lg border p-3 text-sm ${mode === m.value ? 'border-accent bg-accent/10' : 'border-line'}`}>
            <input type="radio" className="mr-2" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span className="font-medium">{m.label}</span>
            <span className="block pl-5 text-xs text-muted">{m.hint}</span>
          </label>
        ))}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-full px-4 py-1.5 text-sm text-muted hover:bg-white/10 hover:text-white">Cancel</button>
        <button
          disabled={!path.trim() || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onAdd(path.trim(), mode)
            } finally {
              setBusy(false)
            }
          }}
          className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
        >
          {busy ? 'Adding…' : 'Add folder'}
        </button>
      </div>
    </div>
  )
}
