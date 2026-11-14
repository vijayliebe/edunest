import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, type LessonDetail, type Note } from '../api'
import Curriculum from '../components/Curriculum'
import { NoteEditor, NotesList } from '../components/Notes'
import Player, { type PlayerHandle } from '../components/Player'
import { fmtTime, useLoad } from '../util'

type Tab = 'notes' | 'contents' | 'chapters'
const SAVE_EVERY_S = 10

export default function Watch() {
  const id = Number(useParams().id)
  const [params] = useSearchParams()
  const tParam = params.get('t')
  const nav = useNavigate()
  const player = useRef<PlayerHandle>(null)

  const lesson = useLoad(() => api.lesson(id), [id])
  const notes = useLoad(() => api.notes(id), [id])
  const [courseVersion, setCourseVersion] = useState(0)
  const courseId = lesson.data?.course.id
  const course = useLoad(() => (courseId ? api.course(courseId) : Promise.resolve(null)), [courseId, courseVersion])

  const [tab, setTab] = useState<Tab>('notes')
  const [time, setTime] = useState(0)
  const [composing, setComposing] = useState<{ ts: number; resume: boolean } | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [completed, setCompleted] = useState(false)
  const [showDesc, setShowDesc] = useState(false)

  const l = lesson.data?.id === id ? lesson.data : null

  // ---- progress tracking
  const lastSaved = useRef({ t: -1, id })
  const curT = useRef(0) // last known playback time, survives the player unmounting
  const saveProgress = useCallback(
    async (t: number, done?: boolean, keepalive = false) => {
      if (!l) return
      lastSaved.current = { t, id: l.id }
      try {
        if (keepalive) {
          void fetch(`/api/progress/${l.id}`, {
            method: 'PUT',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position_s: t, completed: done }),
          })
          return
        }
        const r = await api.saveProgress(l.id, t, done)
        if (r.completed !== completed) {
          setCompleted(r.completed)
          setCourseVersion((v) => v + 1)
        }
      } catch {
        /* offline — next save will catch up */
      }
    },
    [l, completed],
  )

  useEffect(() => {
    if (l) setCompleted(!!l.progress.completed)
  }, [l])

  // Save on leaving the page / switching tabs / changing lesson
  useEffect(() => {
    const flush = () => {
      const t = player.current?.currentTime() ?? curT.current
      if (t > 0 && Math.abs(t - lastSaved.current.t) > 1) void saveProgress(t, undefined, true)
    }
    const onVis = () => document.visibilityState === 'hidden' && flush()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', flush)
    return () => {
      flush()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', flush)
    }
  }, [saveProgress])

  const startAt = useMemo(() => {
    if (!l) return 0
    if (tParam !== null && !Number.isNaN(Number(tParam))) return Number(tParam)
    const { position_s, completed: done } = l.progress
    if (done || !l.duration_s || position_s > l.duration_s - 10) return 0
    return Math.max(0, position_s - 2)
    // only recompute when the lesson changes, not on every progress save
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l?.id])

  // ?t=… changes while already on this lesson (e.g. from search) → seek
  useEffect(() => {
    if (tParam !== null && player.current) player.current.seek(Number(tParam))
  }, [tParam])

  // ---- notes
  const sortedNotes = useMemo(
    () => [...(notes.data ?? [])].sort((a, b) => a.timestamp_s - b.timestamp_s || a.id - b.id),
    [notes.data],
  )

  const startNote = useCallback(() => {
    const p = player.current
    if (!p) return
    setComposing((c) => {
      if (c) return c
      const resume = p.isPlaying()
      p.pause()
      return { ts: p.currentTime(), resume }
    })
    setTab('notes')
  }, [])

  const finishNote = (resume: boolean) => {
    setComposing(null)
    if (resume) player.current?.play()
  }

  const setNotes = (fn: (n: Note[]) => Note[]) => notes.setData((cur) => fn(cur ?? []))

  // ---- navigation
  const goPrev = l?.prev ? () => nav(`/watch/${l.prev!.id}`) : undefined
  const goNext = l?.next ? () => nav(`/watch/${l.next!.id}`) : undefined

  useEffect(() => {
    if (countdown === null) return
    if (countdown <= 0) {
      setCountdown(null)
      goNext?.()
      return
    }
    const t = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000)
    return () => window.clearTimeout(t)
  }, [countdown, goNext])

  useEffect(() => {
    setCountdown(null)
    setComposing(null)
    setTime(0)
    curT.current = 0
    lastSaved.current = { t: -1, id }
  }, [id])

  useEffect(() => {
    if (l) document.title = `${l.title} · EduNest`
    return () => {
      document.title = 'EduNest'
    }
  }, [l])

  if (lesson.error) return <p className="p-8 text-red-400">{lesson.error}</p>
  if (!l) return <div className="p-8 text-muted">Loading…</div>

  const seekTo = (t: number) => player.current?.seek(t, true)

  return (
    <div className="mx-auto grid max-w-[1800px] gap-6 p-0 lg:grid-cols-[minmax(0,1fr)_400px] lg:p-6">
      {/* Main column */}
      <div className="min-w-0">
        <div className="relative overflow-hidden lg:rounded-xl">
          <Player
            ref={player}
            key={l.id}
            src={l.stream_url}
            poster={l.thumb_url}
            startAt={startAt}
            durationHint={l.duration_s}
            chapters={l.chapters}
            notes={sortedNotes}
            subtitles={l.subtitles}
            onTime={(t) => {
              setTime(t)
              curT.current = t
              if (Math.abs(t - lastSaved.current.t) >= SAVE_EVERY_S) void saveProgress(t)
            }}
            onPause={(t) => void saveProgress(t)}
            onEnded={() => {
              void saveProgress(l.duration_s ?? player.current?.currentTime() ?? 0, true)
              if (l.next) setCountdown(5)
            }}
            onAddNote={startNote}
            onPrev={goPrev}
            onNext={goNext}
          />
          {countdown !== null && l.next && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 text-center">
              <p className="text-sm text-muted">Up next in {countdown}s</p>
              <p className="max-w-md px-4 text-lg font-semibold">{l.next.title}</p>
              <div className="flex gap-2">
                <button onClick={() => setCountdown(null)} className="rounded-full px-4 py-1.5 text-sm hover:bg-white/10">Cancel</button>
                <button onClick={goNext} className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black">Play now</button>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 lg:px-0">
          {l.playable !== 'yes' && (
            <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              {l.playable === 'maybe'
                ? `This video uses ${l.vcodec?.toUpperCase()}, which plays in Safari but may not play in Chrome/Firefox.`
                : `This file (${l.vcodec ?? 'unknown'}/${l.acodec ?? 'unknown'}) can't be played by browsers. Converting it to MP4 (H.264/AAC) will fix it.`}
            </p>
          )}

          {/* Note composer, right under the video so the frame stays visible */}
          <div className="mt-3">
            {composing ? (
              <NoteEditor
                timestamp={composing.ts}
                onSeek={(t) => player.current?.seek(t)}
                onUseCurrentTime={() => setComposing((c) => c && { ...c, ts: player.current?.currentTime() ?? c.ts })}
                onCancel={() => finishNote(composing.resume)}
                onSave={async (body) => {
                  const n = await api.createNote(l.id, composing.ts, body)
                  setNotes((ns) => [...ns, n])
                  finishNote(composing.resume)
                }}
              />
            ) : (
              <button
                onClick={startNote}
                className="flex w-full items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3 text-left text-sm text-muted hover:border-note/60 hover:text-white"
              >
                <span className="rounded bg-note/20 px-2 py-0.5 font-mono text-xs font-semibold text-note">✎ {fmtTime(time)}</span>
                Add a note at the current moment
                <kbd className="ml-auto rounded border border-line px-1.5 font-mono text-xs">N</kbd>
              </button>
            )}
          </div>

          <h1 className="mt-4 text-xl font-bold">{l.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
            <Link to={`/course/${l.course.id}`} className="font-medium text-slate-200 hover:text-accent-2">{l.course.title}</Link>
            {l.section_title && <span>· {l.section_title}</span>}
            <span>· Lesson {l.index} of {l.total}</span>
            {l.channel && <span>· {l.channel}</span>}
            {l.upload_date && <span>· {l.upload_date}</span>}
            <div className="ml-auto flex gap-2">
              {l.youtube_id && (
                <a
                  href={`https://www.youtube.com/watch?v=${l.youtube_id}&t=${Math.floor(time)}s`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-line px-3 py-1 text-xs hover:bg-white/10 hover:text-white"
                >
                  Open on YouTube ↗
                </a>
              )}
              <button
                onClick={() => void saveProgress(player.current?.currentTime() ?? 0, !completed)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  completed ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' : 'border border-line hover:bg-white/10 hover:text-white'
                }`}
              >
                {completed ? '✓ Completed' : 'Mark as complete'}
              </button>
            </div>
          </div>

          {l.description && (
            <div className="mt-4 rounded-xl bg-panel p-4 text-sm text-slate-300">
              <div className={`whitespace-pre-line ${showDesc ? '' : 'line-clamp-3'}`}>
                <Timestamped text={l.description} onSeek={seekTo} />
              </div>
              <button onClick={() => setShowDesc(!showDesc)} className="mt-1 text-xs font-semibold text-muted hover:text-white">
                {showDesc ? 'Show less' : 'Show more'}
              </button>
            </div>
          )}
          <Shortcuts />
        </div>
      </div>

      {/* Sidebar */}
      <aside className="flex min-h-[400px] flex-col overflow-hidden border-line bg-panel lg:sticky lg:top-20 lg:h-[calc(100vh-6.5rem)] lg:rounded-xl lg:border">
        <div className="flex shrink-0 border-b border-line">
          <TabBtn active={tab === 'notes'} onClick={() => setTab('notes')}>Notes ({sortedNotes.length})</TabBtn>
          <TabBtn active={tab === 'contents'} onClick={() => setTab('contents')}>Course content</TabBtn>
          {l.chapters.length > 0 && <TabBtn active={tab === 'chapters'} onClick={() => setTab('chapters')}>Chapters</TabBtn>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'notes' && (
            <NotesList
              notes={sortedNotes}
              currentTime={time}
              onSeek={seekTo}
              getCurrentTime={() => player.current?.currentTime() ?? 0}
              onUpdate={async (nid, patch) => {
                const n = await api.updateNote(nid, patch)
                setNotes((ns) => ns.map((x) => (x.id === nid ? n : x)))
              }}
              onDelete={async (nid) => {
                await api.deleteNote(nid)
                setNotes((ns) => ns.filter((x) => x.id !== nid))
              }}
            />
          )}
          {tab === 'contents' && (course.data ? <Curriculum sections={course.data.sections} currentId={l.id} compact /> : <p className="p-4 text-muted">Loading…</p>)}
          {tab === 'chapters' && <Chapters lesson={l} time={time} onSeek={seekTo} />}
        </div>
      </aside>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex-1 border-b-2 px-3 py-3 text-sm font-medium ${active ? 'border-white text-white' : 'border-transparent text-muted hover:text-white'}`}
    >
      {children}
    </button>
  )
}

function Chapters({ lesson, time, onSeek }: { lesson: LessonDetail; time: number; onSeek: (t: number) => void }) {
  const current = [...lesson.chapters].reverse().find((c) => time >= c.start_s)
  return (
    <ul className="p-2">
      {lesson.chapters.map((c) => (
        <li key={c.start_s}>
          <button
            onClick={() => onSeek(c.start_s)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5 ${c === current ? 'bg-accent/15 font-semibold' : ''}`}
          >
            <span className="w-14 shrink-0 font-mono text-xs text-accent-2">{fmtTime(c.start_s)}</span>
            {c.title}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Turns "12:34" / "1:02:03" in YouTube-style descriptions into seek links. */
function Timestamped({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const parts = text.split(/(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <span key={i}>{p}</span>
        const secs = p.split(':').map(Number).reduce((a, b) => a * 60 + b, 0)
        return (
          <button key={i} onClick={() => onSeek(secs)} className="text-accent-2 hover:underline">
            {p}
          </button>
        )
      })}
    </>
  )
}

function Shortcuts() {
  const keys: [string, string][] = [
    ['N', 'Add note'], ['Space / K', 'Play / pause'], ['← →', '±5 seconds'], ['J L', '±10 seconds'],
    ['< >', 'Speed'], ['F', 'Fullscreen'], ['C', 'Subtitles'], ['M', 'Mute'], ['0–9', 'Jump to 0–90%'],
    ['Shift+N / P', 'Next / previous lesson'],
  ]
  return (
    <details className="mb-8 mt-4 text-sm text-muted">
      <summary className="cursor-pointer select-none hover:text-white">Keyboard shortcuts</summary>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        {keys.map(([k, d]) => (
          <div key={k} className="flex items-center gap-2">
            <kbd className="rounded border border-line bg-panel-2 px-1.5 font-mono text-xs text-slate-200">{k}</kbd>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </details>
  )
}
