import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

/** Markdown with GFM (tables, task lists) and LaTeX math: $x^2$ and $$\sum_i x_i$$ */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-note">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
