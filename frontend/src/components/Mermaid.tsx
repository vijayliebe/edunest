import { useEffect, useId, useState } from 'react'

type MermaidApi = typeof import('mermaid').default
let loading: Promise<MermaidApi> | null = null

/** mermaid is large, so it's loaded only when a page actually contains a diagram. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default)
  return loading
}

/** Draws a ```mermaid code block as a diagram. Invalid or unfinished diagrams (for example while
 *  a chat answer is still streaming) show their code instead. */
export default function Mermaid({ code, light = false }: { code: string; light?: boolean }) {
  const id = 'm' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [big, setBig] = useState(false)

  useEffect(() => {
    if (!big) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBig(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [big])

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    // wait until the text stops changing (streaming answers), then draw
    const timer = window.setTimeout(async () => {
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict', // no scripts, no click handlers, sanitised labels
          theme: light ? 'default' : 'dark',
          fontFamily: 'inherit',
        })
        if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error('invalid diagram')
        const { svg } = await mermaid.render(`${id}-${Date.now()}`, code)
        if (!cancelled) setSvg(svg)
      } catch {
        if (!cancelled) {
          setSvg(null)
          setFailed(true)
        }
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, light, id])

  if (svg)
    return (
      <>
        <div
          role={light ? undefined : 'button'}
          title={light ? undefined : 'Click to open full size'}
          onClick={light ? undefined : () => setBig(true)}
          className={`mermaid-diagram my-3 flex justify-center overflow-x-auto rounded-lg p-2 [&_svg]:h-auto [&_svg]:max-w-full ${light ? '' : 'cursor-zoom-in'}`}
          // produced by mermaid with securityLevel 'strict' (sanitised with DOMPurify)
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {big && (
          <div
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/85 p-4"
            onClick={() => setBig(false)}
          >
            <div
              className="max-h-full max-w-full overflow-auto rounded-xl bg-panel p-4 [&_svg]:h-auto [&_svg]:max-h-[85vh] [&_svg]:w-[min(1400px,90vw)] [&_svg]:max-w-none"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </>
    )
  return (
    <div>
      <pre className="overflow-x-auto"><code>{code}</code></pre>
      {failed && <p className="text-xs text-muted">This diagram couldn't be drawn, so its code is shown.</p>}
    </div>
  )
}
