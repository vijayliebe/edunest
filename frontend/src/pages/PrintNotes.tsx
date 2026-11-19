import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import Markdown from '../components/Markdown'
import { useLoad } from '../util'

/** Printable study notes (or summary), on white paper. Opens the browser's print dialog, where
 *  "Save as PDF" makes the PDF. Timestamps become links back to that moment in the video. */
export default function PrintNotes() {
  const id = Number(useParams().id)
  const [params] = useSearchParams()
  const kind = params.get('kind') === 'summary' ? 'summary' : 'notes'
  const lesson = useLoad(() => api.lesson(id), [id])
  const doc = useLoad(() => api.ai(id, kind), [id, kind])
  const ref = useRef<HTMLDivElement>(null)
  const [printed, setPrinted] = useState(false)

  const l = lesson.data
  const d = doc.data
  const ready = !!(l && d?.status === 'done' && d.content)

  useEffect(() => {
    if (l) document.title = `${kind === 'summary' ? 'Summary' : 'Study notes'} - ${l.title}`
  }, [l, kind])

  // print once every diagram is drawn (or after a few seconds, whatever happens)
  useEffect(() => {
    if (!ready || printed) return
    const expected = (d!.content!.match(/```mermaid/g) ?? []).length
    const started = Date.now()
    const h = window.setInterval(() => {
      const box = ref.current
      const drawn = box?.querySelectorAll('.mermaid-diagram').length ?? 0
      const failed = box?.querySelectorAll('pre + p.text-xs').length ?? 0
      if (drawn + failed >= expected || Date.now() - started > 6000) {
        window.clearInterval(h)
        setPrinted(true)
        window.setTimeout(() => window.print(), 300)
      }
    }, 200)
    return () => window.clearInterval(h)
  }, [ready, printed, d])

  if (lesson.error || doc.error) return <p className="p-8">{lesson.error || doc.error}</p>
  if (!l || !d) return <p className="p-8">Loading…</p>
  if (!ready) return <p className="p-8">The {kind === 'summary' ? 'summary' : 'study notes'} for this video haven't been created yet.</p>

  const videoUrl = `${window.location.origin}/watch/${l.id}`
  return (
    <div className="print-page min-h-screen bg-white text-slate-900">
      <div className="no-print sticky top-0 flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-6 py-3 text-sm">
        <span>Choose <b>Save as PDF</b> in the print dialog.</span>
        <button onClick={() => window.print()} className="rounded-lg bg-slate-900 px-3 py-1 text-white">Print / Save as PDF</button>
        <button onClick={() => window.close()} className="ml-auto text-slate-500 hover:text-slate-900">Close</button>
      </div>
      <div ref={ref} className="mx-auto max-w-3xl px-8 py-8">
        <p className="text-sm text-slate-500">{l.course.title}{l.section_title ? ` · ${l.section_title}` : ''}</p>
        <h1 className="mb-1 text-2xl font-bold">{l.title}</h1>
        <p className="mb-6 text-sm text-slate-500">
          {kind === 'summary' ? 'Summary' : 'Study notes'} · <a href={videoUrl} className="text-indigo-700">{videoUrl}</a>
        </p>
        <Markdown light tsHref={(t) => `${videoUrl}?t=${t}`}>{d.content!}</Markdown>
        <p className="mt-10 border-t border-slate-200 pt-3 text-xs text-slate-400">
          Written by AI ({d.model}) from the video's transcript. It can contain mistakes.
        </p>
      </div>
    </div>
  )
}
