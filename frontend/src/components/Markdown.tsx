import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

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

/** Markdown with GFM (tables, task lists) and LaTeX math: $x^2$ and $$\sum_i x_i$$.
 *  With `onSeek`, timestamps in square brackets become links that jump the video there. */
export default function Markdown({ children, onSeek }: { children: string; onSeek?: (t: number) => void }) {
  return (
    <div className="prose-note">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children: c, ...p }) => {
            if (onSeek && href?.startsWith('#t=')) {
              const t = Number(href.slice(3))
              return (
                <button type="button" onClick={() => onSeek(t)} className="font-mono text-accent-2 hover:underline">
                  {c}
                </button>
              )
            }
            return <a {...p} href={href} target="_blank" rel="noreferrer">{c}</a>
          },
        }}
      >
        {onSeek ? linkTimestamps(children) : children}
      </ReactMarkdown>
    </div>
  )
}
