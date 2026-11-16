import { Link } from 'react-router-dom'
import { api } from '../api'
import { useLayout } from '../components/Layout'
import ProgressBar from '../components/ProgressBar'
import Thumb from '../components/Thumb'
import { fmtDuration, fmtTime, pct, useLoad } from '../util'

export default function Home() {
  const { scanVersion, scan } = useLayout()
  const courses = useLoad(() => api.courses(), [scanVersion])
  const cont = useLoad(() => api.continueWatching(), [scanVersion])

  const hide = async (courseId: number) => {
    cont.setData((d) => d?.filter((c) => c.course_id !== courseId) ?? null)
    try {
      await api.hideContinue(courseId)
    } catch {
      void cont.reload()
    }
  }
  const clearAll = async () => {
    if (!confirm('Clear the Continue watching list? Your progress and notes are kept.')) return
    cont.setData([])
    try {
      await api.clearContinue()
    } catch {
      void cont.reload()
    }
  }

  const list = courses.data ?? []
  const empty = !courses.loading && list.length === 0

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
      {cont.data && cont.data.length > 0 && (
        <section className="mb-10">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Continue watching</h2>
            <button
              onClick={clearAll}
              className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-white/5 hover:text-white"
            >
              Clear all
            </button>
          </div>
          <div className="-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2">
            {cont.data.map((c) => (
              <Link
                key={c.lesson_id}
                to={`/watch/${c.lesson_id}`}
                className="group w-72 shrink-0 snap-start"
              >
                <div className="relative overflow-hidden rounded-xl">
                  <button
                    title="Remove from Continue watching"
                    aria-label="Remove from Continue watching"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void hide(c.course_id)
                    }}
                    className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-black/70 text-white opacity-100 transition hover:bg-black/90 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                  <Thumb src={c.thumb_url} title={c.title} className="transition group-hover:scale-[1.02]" />
                  <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs">
                    {fmtTime(c.position_s)} / {fmtTime(c.duration_s)}
                  </span>
                  <ProgressBar value={pct(c.position_s, c.duration_s ?? 0)} className="absolute inset-x-0 bottom-0" />
                </div>
                <p className="mt-2 line-clamp-2 text-sm font-medium group-hover:text-accent-2">{c.title}</p>
                <p className="text-xs text-muted">{c.course_title}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Courses</h2>
        {courses.error && <p className="text-red-400">Could not load courses: {courses.error}</p>}
        {empty && (
          <div className="rounded-xl border border-dashed border-line p-10 text-center text-muted">
            {scan?.running ? (
              <p>Scanning your library… courses will show up here.</p>
            ) : (
              <>
                <p>No courses found yet.</p>
                <p className="mt-1 text-sm">
                  Add your video folders in{' '}
                  <Link to="/settings" className="text-accent-2 hover:underline">Settings</Link>.
                </p>
              </>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {list.map((c) => {
            const done = pct(c.completed_count, c.lesson_count)
            return (
              <Link key={c.id} to={`/course/${c.id}`} className="group">
                <div className="relative overflow-hidden rounded-xl">
                  <Thumb src={c.thumb_url} title={c.title} className="transition group-hover:scale-[1.02]" />
                  <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs">
                    {c.lesson_count} lessons
                  </span>
                  {done > 0 && <ProgressBar value={done} className="absolute inset-x-0 bottom-0" />}
                </div>
                <h3 className="mt-2 line-clamp-2 font-medium group-hover:text-accent-2">{c.title}</h3>
                <p className="text-xs text-muted">
                  {c.channel ? `${c.channel} · ` : ''}
                  {fmtDuration(c.total_duration_s)}
                  {done > 0 && ` · ${done}% done`}
                  {c.notes_count > 0 && ` · ${c.notes_count} notes`}
                </p>
              </Link>
            )
          })}
        </div>
      </section>
    </div>
  )
}
