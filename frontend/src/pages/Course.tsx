import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type CourseNote } from '../api'
import Curriculum from '../components/Curriculum'
import { useLayout } from '../components/Layout'
import Markdown from '../components/Markdown'
import Thumb from '../components/Thumb'
import { fmtDuration, fmtTime, pct, useLoad } from '../util'

export default function CoursePage() {
  const id = Number(useParams().id)
  const { scanVersion } = useLayout()
  const course = useLoad(() => api.course(id), [id, scanVersion])
  const [tab, setTab] = useState<'curriculum' | 'notes'>('curriculum')
  const [showDesc, setShowDesc] = useState(false)

  if (course.error) return <p className="p-8 text-red-400">{course.error}</p>
  const c = course.data
  if (!c) return <div className="p-8 text-muted">Loading…</div>

  const done = pct(c.completed_count, c.lesson_count)

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-6 md:flex-row">
        <Thumb src={c.thumb_url} title={c.title} className="w-full shrink-0 rounded-xl md:w-80" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{c.title}</h1>
          <p className="mt-1 text-sm text-muted">
            {c.channel && <>{c.channel} · </>}
            {c.lesson_count} lessons · {fmtDuration(c.total_duration_s)}
            {c.notes_count > 0 && <> · {c.notes_count} notes</>}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <div className="h-2 w-48 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-emerald-500" style={{ width: `${done}%` }} />
            </div>
            <span className="text-sm text-muted">
              {c.completed_count}/{c.lesson_count} completed
            </span>
          </div>
          {c.resume_lesson_id && (
            <Link
              to={`/watch/${c.resume_lesson_id}`}
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2 font-semibold text-black hover:bg-white/90"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              {c.completed_count > 0 ? 'Continue' : 'Start course'}
            </Link>
          )}
          {c.description && (
            <div className="mt-4 text-sm text-slate-300">
              <p className={`whitespace-pre-line ${showDesc ? '' : 'line-clamp-3'}`}>{c.description}</p>
              <button onClick={() => setShowDesc(!showDesc)} className="mt-1 text-xs font-semibold text-muted hover:text-white">
                {showDesc ? 'Show less' : 'Show more'}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 flex items-center gap-1 border-b border-line">
        {(['curriculum', 'notes'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${
              tab === t ? 'border-white text-white' : 'border-transparent text-muted hover:text-white'
            }`}
          >
            {t === 'notes' ? `All notes (${c.notes_count})` : 'Curriculum'}
          </button>
        ))}
        {tab === 'notes' && c.notes_count > 0 && (
          <a href={`/api/courses/${c.id}/notes/export.md`} className="ml-auto rounded-full px-3 py-1 text-xs text-muted hover:bg-white/10 hover:text-white">
            ⤓ Export Markdown
          </a>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
        {tab === 'curriculum' ? <Curriculum sections={c.sections} /> : <CourseNotes courseId={c.id} />}
      </div>
    </div>
  )
}

function CourseNotes({ courseId }: { courseId: number }) {
  const notes = useLoad(() => api.courseNotes(courseId), [courseId])
  if (!notes.data) return <p className="p-6 text-muted">Loading…</p>
  if (notes.data.length === 0)
    return <p className="p-6 text-muted">No notes yet. While watching, press <Kbd>N</Kbd> to add a note at the current moment.</p>

  const groups: { lessonId: number; title: string; section: string | null; notes: CourseNote[] }[] = []
  for (const n of notes.data) {
    const last = groups[groups.length - 1]
    if (last?.lessonId === n.lesson_id) last.notes.push(n)
    else groups.push({ lessonId: n.lesson_id, title: n.lesson_title, section: n.section_title, notes: [n] })
  }

  return (
    <div className="divide-y divide-line">
      {groups.map((g) => (
        <div key={g.lessonId} className="p-4">
          {g.section && <p className="text-xs uppercase tracking-wide text-muted">{g.section}</p>}
          <Link to={`/watch/${g.lessonId}`} className="font-semibold hover:text-accent-2">{g.title}</Link>
          <ul className="mt-2 space-y-2">
            {g.notes.map((n) => (
              <li key={n.id} className="flex gap-3">
                <Link
                  to={`/watch/${n.lesson_id}?t=${Math.floor(n.timestamp_s)}`}
                  className="h-fit shrink-0 rounded bg-note/15 px-2 py-0.5 font-mono text-xs text-note hover:bg-note/25"
                >
                  {fmtTime(n.timestamp_s)}
                </Link>
                <div className="min-w-0 flex-1"><Markdown>{n.body_md}</Markdown></div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-slate-200">{children}</kbd>
}
