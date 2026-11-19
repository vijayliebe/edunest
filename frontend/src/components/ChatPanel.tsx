import { useEffect, useRef, useState } from 'react'
import { api, type ChatMessage } from '../api'
import { fmtTime, useLoad } from '../util'
import Markdown from './Markdown'

const SUGGESTIONS = [
  'Explain the main idea of this video simply',
  'What should I remember from this video?',
  'Give me 3 practice questions with answers',
  'Explain what is being said at this moment',
]

export default function ChatPanel({
  lessonId, onSeek, getTime,
}: {
  lessonId: number
  onSeek: (t: number) => void
  getTime: () => number
}) {
  const state = useLoad(() => api.chat(lessonId), [lessonId])
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState<string | null>(null) // the answer as it arrives
  const [err, setErr] = useState<string | null>(null)
  const [withTime, setWithTime] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setMsgs(state.data?.messages ?? [])
  }, [state.data])
  useEffect(() => {
    setErr(null)
    setStreaming(null)
  }, [lessonId])
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [msgs.length, streaming])

  const s = state.data
  const busy = streaming !== null

  const ask = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    const at = withTime ? Math.floor(getTime()) : null
    setErr(null)
    setInput('')
    setMsgs((m) => [...m, { role: 'user', content: q, at_s: at }])
    setStreaming('')
    let answer = ''
    try {
      await api.chatAsk(lessonId, q, at, (d) => {
        answer += d
        setStreaming(answer)
      })
      setMsgs((m) => [...m, { role: 'assistant', content: answer }])
    } catch (e) {
      // the question wasn't saved: take it back out and put it in the box to try again
      setMsgs((m) => m.slice(0, -1))
      setInput(q)
      setErr((e as Error).message)
    } finally {
      setStreaming(null)
      inputRef.current?.focus()
    }
  }

  const clear = async () => {
    if (!confirm('Clear this conversation?')) return
    await api.clearChat(lessonId)
    setMsgs([])
  }

  if (!s) return <p className="p-4 text-sm text-muted">Loading…</p>
  if (!s.enabled)
    return (
      <p className="p-4 text-sm text-muted">
        Chat is off. An admin can turn it on by adding an OpenRouter API key (OPENROUTER_API_KEY) to Lectern's settings.
      </p>
    )
  if (!s.can_chat) return <p className="p-4 text-sm text-muted">Chat isn't available for your account.</p>
  if (!s.transcript_ready)
    return <p className="p-4 text-sm text-muted">Chat needs this video's transcript, which isn't ready yet.</p>

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 space-y-4 p-4 text-sm">
        {msgs.length === 0 && !busy && (
          <div className="space-y-3 text-muted">
            <p>Ask anything about this video. Answers point to the moments in the video, and work for videos in any language.</p>
            <div className="flex flex-col items-start gap-2">
              {SUGGESTIONS.map((q) => (
                <button key={q} onClick={() => void ask(q)} className="rounded-lg border border-line px-3 py-1.5 text-left hover:bg-white/5 hover:text-white">
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => <Bubble key={m.id ?? `new-${i}`} m={m} onSeek={onSeek} />)}
        {streaming !== null && (
          <Bubble m={{ role: 'assistant', content: streaming || '…' }} onSeek={onSeek} />
        )}
        {err && <p className="text-red-400">{err}</p>}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 border-t border-line bg-panel p-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask(input)
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={busy ? 'Answering…' : 'Ask about this video (Enter to send)'}
          className="w-full resize-none rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <div className="mt-1 flex items-center gap-3 text-xs text-muted">
          <label className="flex items-center gap-1.5" title="Tell the assistant where you are in the video, so you can ask about this moment">
            <input type="checkbox" checked={withTime} onChange={(e) => setWithTime(e.target.checked)} />
            Include my position in the video
          </label>
          {msgs.length > 0 && !busy && (
            <button onClick={() => void clear()} className="ml-auto hover:text-white">Clear chat</button>
          )}
          <button
            disabled={busy || !input.trim()}
            onClick={() => void ask(input)}
            className={`${msgs.length > 0 && !busy ? '' : 'ml-auto'} rounded-lg bg-white px-3 py-1 font-medium text-black disabled:opacity-40`}
          >
            Send
          </button>
        </div>
        <p className="mt-1 text-[11px] text-muted">Answers are written by AI and can be wrong. Only you can see this chat.</p>
      </div>
    </div>
  )
}

function Bubble({ m, onSeek }: { m: ChatMessage; onSeek: (t: number) => void }) {
  if (m.role === 'user')
    return (
      <div className="ml-8 rounded-xl bg-accent/15 px-3 py-2">
        <p className="whitespace-pre-wrap">{m.content}</p>
        {m.at_s != null && (
          <button onClick={() => onSeek(m.at_s!)} className="mt-1 font-mono text-xs text-accent-2 hover:underline">
            at {fmtTime(m.at_s)}
          </button>
        )}
      </div>
    )
  return (
    <div className="mr-4">
      <Markdown onSeek={onSeek}>{m.content}</Markdown>
    </div>
  )
}
