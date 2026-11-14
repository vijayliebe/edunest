import { useEffect, useRef, useState } from 'react'
import type { Note } from '../api'
import { fmtTime } from '../util'
import Markdown from './Markdown'

/** Markdown note editor with a timestamp chip. Cmd/Ctrl+Enter saves, Esc cancels. */
export function NoteEditor({
  timestamp,
  initial = '',
  onSave,
  onCancel,
  onUseCurrentTime,
  onSeek,
  saveLabel = 'Save note',
}: {
  timestamp: number
  initial?: string
  onSave: (body: string) => Promise<void> | void
  onCancel: () => void
  onUseCurrentTime?: () => void
  onSeek?: (t: number) => void
  saveLabel?: string
}) {
  const [body, setBody] = useState(initial)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ta.current
    if (el) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])

  // Auto-grow textarea
  useEffect(() => {
    const el = ta.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(320, el.scrollHeight)}px`
    }
  }, [body, preview])

  const save = async () => {
    if (!body.trim() || saving) return
    setSaving(true)
    setErr(null)
    try {
      await onSave(body.trim())
    } catch (e) {
      setErr((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-note/40 bg-panel-2 p-3 shadow-lg">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => onSeek?.(timestamp)}
          className="rounded bg-note/20 px-2 py-0.5 font-mono font-semibold text-note hover:bg-note/30"
          title="Jump to this moment"
        >
          ✎ {fmtTime(timestamp)}
        </button>
        {onUseCurrentTime && (
          <button type="button" onClick={onUseCurrentTime} className="text-muted hover:text-white" title="Set timestamp to the current video time">
            ⟲ use current time
          </button>
        )}
        <div className="ml-auto flex overflow-hidden rounded-md border border-line">
          {(['Write', 'Preview'] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setPreview(m === 'Preview')}
              className={`px-2 py-0.5 ${preview === (m === 'Preview') ? 'bg-white/15 text-white' : 'text-muted hover:text-white'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {preview ? (
        <div className="min-h-20 rounded-md bg-bg/60 p-2">{body.trim() ? <Markdown>{body}</Markdown> : <p className="text-sm text-muted">Nothing to preview</p>}</div>
      ) : (
        <textarea
          ref={ta}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          rows={3}
          placeholder="What's worth remembering here? Markdown and $math$ supported."
          className="block w-full resize-none rounded-md bg-bg/60 p-2 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-note/60"
        />
      )}
      {err && <p className="mt-1 text-xs text-red-400">{err}</p>}
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-muted">⌘/Ctrl+Enter to save · Esc to cancel</span>
        <button type="button" onClick={onCancel} className="rounded-full px-3 py-1 text-sm text-muted hover:bg-white/10 hover:text-white">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!body.trim() || saving}
          className="rounded-full bg-note px-4 py-1 text-sm font-semibold text-black hover:brightness-110 disabled:opacity-40"
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  )
}

/** Sidebar list of timestamped notes for one lesson. Highlights the note at the current playback time. */
export function NotesList({
  notes,
  currentTime,
  onSeek,
  onUpdate,
  onDelete,
  getCurrentTime,
}: {
  notes: Note[]
  currentTime: number
  onSeek: (t: number) => void
  onUpdate: (id: number, patch: { body_md?: string; timestamp_s?: number }) => Promise<void>
  onDelete: (id: number) => Promise<void>
  getCurrentTime: () => number
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [editTs, setEditTs] = useState(0)
  const activeRef = useRef<HTMLLIElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const hovering = useRef(false)

  const activeId = [...notes].reverse().find((n) => n.timestamp_s <= currentTime + 0.25)?.id

  useEffect(() => {
    if (!hovering.current && editing === null) activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeId, editing])

  if (!notes.length) {
    return (
      <div className="p-6 text-center text-sm text-muted">
        <p className="text-3xl">✎</p>
        <p className="mt-2">No notes for this lesson yet.</p>
        <p className="mt-1">
          Press <kbd className="rounded border border-line px-1 font-mono">N</kbd> while watching to capture the current moment.
        </p>
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      className="space-y-2 p-3"
      onMouseEnter={() => (hovering.current = true)}
      onMouseLeave={() => (hovering.current = false)}
    >
      {notes.map((n) =>
        editing === n.id ? (
          <li key={n.id}>
            <NoteEditor
              timestamp={editTs}
              initial={n.body_md}
              saveLabel="Update"
              onSeek={onSeek}
              onUseCurrentTime={() => setEditTs(getCurrentTime())}
              onCancel={() => setEditing(null)}
              onSave={async (body) => {
                await onUpdate(n.id, { body_md: body, timestamp_s: editTs })
                setEditing(null)
              }}
            />
          </li>
        ) : (
          <li
            key={n.id}
            ref={n.id === activeId ? activeRef : undefined}
            className={`group rounded-xl border p-3 transition ${
              n.id === activeId ? 'border-note/50 bg-note/10' : 'border-line bg-panel-2/50 hover:border-white/20'
            }`}
          >
            <div className="mb-1 flex items-center gap-2">
              <button
                onClick={() => onSeek(n.timestamp_s)}
                className="rounded bg-note/20 px-2 py-0.5 font-mono text-xs font-semibold text-note hover:bg-note/30"
                title="Jump to this moment"
              >
                ▶ {fmtTime(n.timestamp_s)}
              </button>
              <div className="ml-auto flex gap-1 opacity-0 transition group-hover:opacity-100">
                <button
                  onClick={() => {
                    setEditTs(n.timestamp_s)
                    setEditing(n.id)
                  }}
                  className="rounded px-2 py-0.5 text-xs text-muted hover:bg-white/10 hover:text-white"
                >
                  Edit
                </button>
                <button
                  onClick={() => {
                    if (confirm('Delete this note?')) void onDelete(n.id)
                  }}
                  className="rounded px-2 py-0.5 text-xs text-muted hover:bg-red-500/20 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            </div>
            <Markdown>{n.body_md}</Markdown>
          </li>
        ),
      )}
    </ul>
  )
}
