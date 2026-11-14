import { useState } from 'react'
import { api, type Library } from '../api'
import { useLayout } from '../components/Layout'
import { useLoad } from '../util'

const MODES: { value: Library['mode']; label: string; hint: string }[] = [
  { value: 'collection', label: 'Folder of courses', hint: 'Each sub-folder is a course' },
  { value: 'course', label: 'Single course', hint: 'This folder itself is one course' },
]

export default function Settings() {
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
