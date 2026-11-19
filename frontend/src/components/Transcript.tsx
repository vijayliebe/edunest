import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Transcript as T, type TranscriptSegment } from '../api'
import { fmtTime } from '../util'

export function languageName(code?: string | null): string {
  if (!code) return 'Unknown language'
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export function transcriptLabel(t: T): string {
  const how = t.source === 'youtube' ? 'YouTube' : t.source === 'whisper' ? 'auto-generated' : 'subtitles'
  return `${languageName(t.language)} · ${how}`
}

const PENDING = new Set(['queued', 'fetching', 'whisper', 'transcribing'])
export const isPending = (t?: T | null) =>
  !!t?.enabled && (PENDING.has(t.status ?? '') || ['queued', 'working'].includes(t.translation?.status ?? ''))

function localTime(utc: string) {
  return new Date(utc.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Status({ t }: { t: T }) {
  switch (t.status) {
    case 'queued':
    case 'fetching':
      return t.next_try_at ? (
        <p>YouTube asked us to slow down. Trying again at {localTime(t.next_try_at)}.</p>
      ) : (
        <p>Looking for subtitles and YouTube captions…</p>
      )
    case 'whisper':
      return <p>No subtitles found anywhere, so this video will be transcribed from its audio. It's waiting in the queue.</p>
    case 'transcribing':
      return (
        <div>
          <p>Transcribing from the audio… {Math.round((t.progress ?? 0) * 100)}%</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10">
            <div className="h-full bg-accent" style={{ width: `${(t.progress ?? 0) * 100}%` }} />
          </div>
        </div>
      )
    case 'failed':
      return <p>No transcript for this video. {t.error}</p>
    case 'unavailable':
      return <p>The transcript service isn't reachable right now.</p>
    default:
      return null
  }
}

export default function TranscriptPanel({
  t, lessonId, time, onSeek, isAdmin, onRetry, onTranslated,
}: {
  t: T
  lessonId: number
  time: number
  onSeek: (s: number) => void
  isAdmin: boolean
  onRetry: (whisper: boolean) => Promise<void>
  onTranslated: () => void
}) {
  const [english, setEnglish] = useState(false)
  const [enSegs, setEnSegs] = useState<TranscriptSegment[] | null>(null)
  const tl = t.translation
  useEffect(() => {
    setEnglish(false)
    setEnSegs(null)
  }, [lessonId])
  useEffect(() => {
    if (!english || enSegs || tl?.status !== 'done') return
    api.transcript(lessonId, 'en').then((r) => setEnSegs(r.segments)).catch(() => setEnglish(false))
  }, [english, enSegs, tl?.status, lessonId])
  const translate = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.aiGenerate(lessonId, 'translation')
      onTranslated()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const [q, setQ] = useState('')
  const [follow, setFollow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const segs = english && enSegs ? enSegs : t.segments
  const active = useMemo(() => {
    let lo = 0, hi = segs.length - 1, ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid].start <= time + 0.25) { ans = mid; lo = mid + 1 } else hi = mid - 1
    }
    return ans
  }, [segs, time])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return segs.map((s, i) => ({ ...s, i })).filter((s) => !needle || s.text.toLowerCase().includes(needle))
  }, [segs, q])

  // keep the current line in view, scrolling only the sidebar (never the page)
  useEffect(() => {
    if (!follow || q || active < 0) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)
    const box = listRef.current?.closest<HTMLElement>('.overflow-y-auto')
    if (!el || !box) return
    const top = el.offsetTop - box.offsetTop
    if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 80) {
      box.scrollTo({ top: top - box.clientHeight / 3, behavior: 'smooth' })
    }
  }, [active, follow, q])

  const retry = async (whisper: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      await onRetry(whisper)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const adminTools = isAdmin && (t.status === 'done' || t.status === 'failed') && (
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} onClick={() => retry(false)} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-50">
        Look again
      </button>
      <button disabled={busy} onClick={() => retry(true)} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-50">
        Transcribe from audio
      </button>
      {err && <span className="text-xs text-red-400">{err}</span>}
    </div>
  )

  if (t.status !== 'done') {
    return (
      <div className="space-y-3 p-4 text-sm text-muted">
        <Status t={t} />
        {adminTools}
      </div>
    )
  }

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search transcript"
          className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        {tl?.status === 'done' && (
          <button
            onClick={() => setEnglish((e) => !e)}
            title="Switch between the original language and the English translation"
            className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs hover:bg-white/5"
          >
            {english ? 'Original' : 'English'}
          </button>
        )}
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted" title="Keep the current line in view">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>
      <ul ref={listRef} className="p-2">
        {shown.map((s) => (
          <li key={s.i} data-i={s.i}>
            <button
              onClick={() => onSeek(s.start)}
              className={`flex w-full gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5 ${s.i === active ? 'bg-accent/15 text-white' : 'text-slate-300'}`}
            >
              <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-accent-2">{fmtTime(s.start)}</span>
              <span>{s.text}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="p-3 text-sm text-muted">No lines match “{q}”.</li>}
      </ul>
      <div className="space-y-2 border-t border-line p-3 text-xs text-muted">
        <p>
          {transcriptLabel(t)}
          {t.source_detail ? ` (${t.source_detail})` : ''}
          {english && enSegs ? ' · shown translated to English by AI' : ''}
        </p>
        {tl && tl.enabled && tl.status !== 'done' && (
          tl.status === 'queued' || tl.status === 'working' ? (
            <p>Translating to English… English subtitles will appear in the CC menu when it's done.</p>
          ) : t.can_generate ? (
            <div className="flex flex-wrap items-center gap-2">
              <button disabled={busy} onClick={translate} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-white/5 disabled:opacity-50">
                Translate to English
              </button>
              {tl.status === 'failed' && <span className="text-red-400">Last try failed: {tl.error}</span>}
            </div>
          ) : null
        )}
        {adminTools}
      </div>
    </div>
  )
}
