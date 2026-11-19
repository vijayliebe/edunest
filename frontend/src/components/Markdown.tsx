import { isValidElement, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import Mermaid from './Mermaid'

const TS = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\](?!\()/g

export function tsToSeconds(ts: string): number {
  return ts.split(':').map(Number).reduce((a, b) => a * 60 + b, 0)
}

/** Turns "[12:34]" / "[1:02:03]" into links that seek the video (outside code blocks). */
function linkTimestamps(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(TS, (_, ts: string) => `[${ts}](#t=${tsToSeconds(ts)})`)))
    .join('')
}

/** Markdown with GFM (tables, task lists), LaTeX math ($x^2$, $$\sum_i x_i$$) and ```mermaid diagrams.
 *  With `onSeek`, timestamps in square brackets become buttons that jump the video there; with
 *  `tsHref` they become ordinary links instead (for printed / PDF notes). `light` is for printing. */
export default function Markdown({
  children, onSeek, tsHref, light = false,
}: {
  children: string
  onSeek?: (t: number) => void
  tsHref?: (t: number) => string
  light?: boolean
}) {
  const timestamps = !!(onSeek || tsHref)
  return (
    <div className={light ? 'prose-print' : 'prose-note'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children: c, ...p }) => {
            if (timestamps && href?.startsWith('#t=')) {
              const t = Number(href.slice(3))
              if (tsHref) return <a href={tsHref(t)} className="ts-link">{c}</a>
              return (
                <button type="button" onClick={() => onSeek!(t)} className="font-mono text-accent-2 hover:underline">
                  {c}
                </button>
              )
            }
            return <a {...p} href={href} target="_blank" rel="noreferrer">{c}</a>
          },
          pre: ({ children: c, ...p }) => {
            const code = isValidElement(c) ? (c as ReactElement<{ className?: string; children?: unknown }>) : null
            if (code?.props.className?.includes('language-mermaid'))
              return <Mermaid code={String(code.props.children ?? '').trim()} light={light} />
            return <pre {...p}>{c}</pre>
          },
        }}
      >
        {timestamps ? linkTimestamps(children) : children}
      </ReactMarkdown>
    </div>
  )
}
