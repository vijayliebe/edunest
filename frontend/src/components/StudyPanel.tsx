import { useEffect, useState } from 'react'
import { api, type AiArtifact } from '../api'
import { useLoad } from '../util'
import ChatPanel from './ChatPanel'
import Markdown, { tsToSeconds } from './Markdown'

type Kind = 'summary' | 'notes'
const NAME: Record<Kind, string> = { summary: 'summary', notes: 'study notes' }

/** "## [mm:ss] Title" sections of the study notes, ready to become the user's own notes. */
export function noteSections(md: string): { t: number; body: string }[] {
  const out: { t: number; body: string }[] = []
  const parts = md.split(/^## /m).slice(1)
  let last = 0
  for (const p of parts) {
    const [head, ...rest] = p.split('\n')
    const m = head.match(/^\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]\s*(.*)$/)
    const body = rest.join('\n').trim()
    if (!body) continue
    if (m) last = tsToSeconds(m[1])
    // a section without a timestamp (e.g. "Review questions") goes with the section before it
    out.push({ t: last, body: `**${(m ? m[2] : head).trim()}**\n\n${body}` })
  }
  return out
}

type Props = {
  lessonId: number
  transcriptReady: boolean
  isAdmin: boolean
  onSeek: (t: number) => void
  getTime: () => number
  onSaveNotes: (sections: { t: number; body: string }[]) => Promise<void>
}

/** The AI tab: summary, study notes, and chat with the video. */
export default function StudyPanel(props: Props) {
  const [mode, setMode] = useState<Kind | 'chat'>('summary')
  const label = { summary: 'Summary', notes: 'Study notes', chat: 'Chat' }
  return (
    <div className="flex flex-1 flex-col">
      <div className="sticky top-0 z-10 flex gap-1 border-b border-line bg-panel p-2">
        {(['summary', 'notes', 'chat'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setMode(k)}
            className={`rounded-full px-3 py-1 text-sm ${mode === k ? 'bg-white text-black' : 'text-muted hover:bg-white/5 hover:text-white'}`}
          >
            {label[k]}
          </button>
        ))}
      </div>
      {mode === 'chat' ? (
        <div className="flex flex-1 flex-col">
          <ChatPanel lessonId={props.lessonId} onSeek={props.onSeek} getTime={props.getTime} />
        </div>
      ) : (
        <Artifact key={mode} kind={mode} {...props} />
      )}
    </div>
  )
}

function Artifact({ kind, lessonId, transcriptReady, isAdmin, onSeek, onSaveNotes }: Props & { kind: Kind }) {
  const a = useLoad(() => api.ai(lessonId, kind), [lessonId, kind])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const d: AiArtifact | null = a.data

  const pending = d?.status === 'queued' || d?.status === 'working'
  useEffect(() => {
    if (!pending) return
    const h = window.setInterval(() => void a.reload(), 4000)
    return () => window.clearInterval(h)
  }, [pending, a.reload])
  useEffect(() => setSaved(null), [lessonId, kind, d?.updated_at])

  const generate = async (again = false) => {
    setBusy(true)
    setErr(null)
    try {
      a.setData(await api.aiGenerate(lessonId, kind, again))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!d?.content) return
    const sections = noteSections(d.content)
    if (!sections.length) return
    if (!confirm(`Add ${sections.length} notes to your own notes for this video, each at its moment in the video?`)) return
    setBusy(true)
    try {
      await onSaveNotes(sections)
      setSaved(sections.length)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const btn = 'rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50'

  let body: React.ReactNode
  if (!d) body = <p className="text-muted">Loading…</p>
  else if (d.status === 'unavailable') body = <p className="text-muted">The transcript service isn't reachable right now.</p>
  else if (!d.enabled) body = (
    <p className="text-muted">
      Summaries and study notes are off. An admin can turn them on by adding an OpenRouter API key (OPENROUTER_API_KEY) to Lectern's settings.
    </p>
  )
  else if (d.status === 'none') body = (
    <div className="space-y-3 text-muted">
      <p>
        {kind === 'summary'
          ? 'A short overview: what the video covers, its key points with links to each moment, and an outline.'
          : 'Detailed notes you can study from instead of rewatching: explanations, definitions, formulas and examples, part by part, plus review questions.'}{' '}
        Always in English. Made once and shared with everyone who can see this course.
      </p>
      {!transcriptReady ? (
        <p>This needs the video's transcript first, which isn't ready yet.</p>
      ) : d.can_generate ? (
        <button disabled={busy} onClick={() => generate()} className={btn}>
          Create {NAME[kind]}
        </button>
      ) : (
        <p>Not created yet. Ask an admin to create it.</p>
      )}
    </div>
  )
  else if (pending) body = (
    <p className="text-muted">
      Writing the {NAME[kind]}… this usually takes {kind === 'summary' ? 'under a minute' : 'one to three minutes'}. You can keep watching.
    </p>
  )
  else if (d.status === 'failed') body = (
    <div className="space-y-3">
      <p className="text-red-400">Couldn't create the {NAME[kind]}: {d.error}</p>
      {d.can_generate && <button disabled={busy} onClick={() => generate()} className={btn}>Try again</button>}
    </div>
  )
  else body = (
    <div>
      <Markdown onSeek={onSeek}>{d.content ?? ''}</Markdown>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
        {kind === 'notes' && (
          <button disabled={busy || saved !== null} onClick={save} className={btn}>
            {saved !== null ? `Added ${saved} notes` : 'Save to my notes'}
          </button>
        )}
        {d.can_regenerate && (
          <button disabled={busy} onClick={() => confirm(`Write the ${NAME[kind]} again? It replaces the current one for everyone.`) && generate(true)} className={btn}>
            Write again
          </button>
        )}
        <span className="ml-auto">
          Written by AI ({d.model}){isAdmin && d.input_tokens ? ` · ${d.input_tokens.toLocaleString()} in / ${d.output_tokens?.toLocaleString()} out tokens` : ''}.
          {' '}It can make mistakes.
        </span>
      </div>
    </div>
  )

  return (
    <div className="p-4 text-sm">
      {body}
      {err && <p className="mt-3 text-red-400">{err}</p>}
    </div>
  )
}
