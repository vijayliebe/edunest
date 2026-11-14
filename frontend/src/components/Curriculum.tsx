import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Section } from '../api'
import { fmtDuration, fmtTime } from '../util'

/** Udemy-style collapsible curriculum. `compact` is the watch-page sidebar variant. */
export default function Curriculum({
  sections,
  currentId,
  compact = false,
}: {
  sections: Section[]
  currentId?: number
  compact?: boolean
}) {
  const currentRef = useRef<HTMLAnchorElement>(null)
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentId])

  return (
    <div className="divide-y divide-line">
      {sections.map((s, si) => {
        const key = String(s.id ?? `root-${si}`)
        const done = s.lessons.filter((l) => l.completed).length
        const total = s.lessons.reduce((a, l) => a + (l.duration_s ?? 0), 0)
        const isClosed = closed[key]
        return (
          <div key={key}>
            {(s.title || sections.length > 1) && (
              <button
                onClick={() => setClosed((c) => ({ ...c, [key]: !c[key] }))}
                className="flex w-full items-start gap-2 bg-panel-2/60 px-4 py-3 text-left hover:bg-panel-2"
              >
                <svg viewBox="0 0 24 24" className={`mt-0.5 h-4 w-4 shrink-0 transition ${isClosed ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{s.title ?? 'Introduction'}</span>
                  <span className="text-xs text-muted">
                    {done}/{s.lessons.length} · {fmtDuration(total)}
                  </span>
                </span>
              </button>
            )}
            {!isClosed && (
              <ul>
                {s.lessons.map((l, li) => {
                  const active = l.id === currentId
                  return (
                    <li key={l.id}>
                      <Link
                        ref={active ? currentRef : undefined}
                        to={`/watch/${l.id}`}
                        className={`flex items-start gap-3 px-4 ${compact ? 'py-2' : 'py-3'} text-sm hover:bg-white/5 ${active ? 'bg-accent/15' : ''}`}
                      >
                        <span
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                            l.completed ? 'border-emerald-500 bg-emerald-500 text-black' : 'border-white/30 text-muted'
                          }`}
                          title={l.completed ? 'Completed' : 'Not completed'}
                        >
                          {l.completed ? '✓' : li + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block ${active ? 'font-semibold text-white' : ''}`}>{l.title}</span>
                          <span className="flex items-center gap-2 text-xs text-muted">
                            <span>{fmtTime(l.duration_s)}</span>
                            {l.notes_count > 0 && <span className="text-note">✎ {l.notes_count}</span>}
                            {l.playable === 'no' && <span className="text-red-400">unsupported format</span>}
                            {l.playable === 'maybe' && <span className="text-amber-400">HEVC (Safari)</span>}
                          </span>
                        </span>
                        {active && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent-2" />}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
