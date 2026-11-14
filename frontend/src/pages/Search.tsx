import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import Thumb from '../components/Thumb'
import { fmtTime, useLoad } from '../util'

/** Escapes everything except the <mark> tags produced by SQLite's snippet(). */
function safeSnippet(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}

export default function SearchPage() {
  const q = useSearchParams()[0].get('q') ?? ''
  const res = useLoad(() => api.search(q), [q])
  const r = res.data

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-lg font-semibold">
        Results for <span className="text-accent-2">“{q}”</span>
      </h1>
      {res.error && <p className="mt-4 text-red-400">{res.error}</p>}
      {r && !r.courses.length && !r.lessons.length && !r.notes.length && <p className="mt-6 text-muted">Nothing found.</p>}

      {r && r.notes.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Your notes</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
            {r.notes.map((n) => (
              <li key={n.id}>
                <Link to={`/watch/${n.lesson_id}?t=${Math.floor(n.timestamp_s)}`} className="flex gap-3 p-3 hover:bg-white/5">
                  <span className="h-fit shrink-0 rounded bg-note/15 px-2 py-0.5 font-mono text-xs text-note">{fmtTime(n.timestamp_s)}</span>
                  <span className="min-w-0">
                    <span className="block text-sm" dangerouslySetInnerHTML={{ __html: safeSnippet(n.snippet) }} />
                    <span className="text-xs text-muted">
                      {n.lesson_title} · {n.course_title}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r && r.courses.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Courses</h2>
          <div className="flex flex-wrap gap-2">
            {r.courses.map((c) => (
              <Link key={c.id} to={`/course/${c.id}`} className="rounded-full border border-line px-3 py-1 text-sm hover:bg-white/10">
                {c.title}
              </Link>
            ))}
          </div>
        </section>
      )}

      {r && r.lessons.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Lessons</h2>
          <ul className="space-y-3">
            {r.lessons.map((l) => (
              <li key={l.id}>
                <Link to={`/watch/${l.id}`} className="group flex gap-4">
                  <Thumb src={l.thumb_url} title={l.title} className="w-48 shrink-0 rounded-lg" />
                  <span>
                    <span className="block font-medium group-hover:text-accent-2">{l.title}</span>
                    <span className="text-xs text-muted">
                      {l.course_title} · {fmtTime(l.duration_s)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
