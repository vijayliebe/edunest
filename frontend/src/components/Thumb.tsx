import { useState } from 'react'

const GRADIENTS = [
  'from-indigo-600 to-purple-700',
  'from-sky-600 to-cyan-700',
  'from-emerald-600 to-teal-700',
  'from-rose-600 to-orange-600',
  'from-amber-500 to-red-600',
  'from-fuchsia-600 to-pink-600',
]

/** Thumbnail with a generated gradient fallback when no image is available. */
export default function Thumb({ src, title, className = '' }: { src: string; title: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  const g = GRADIENTS[[...title].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length]
  return (
    <div className={`relative aspect-video overflow-hidden bg-panel-2 ${className}`}>
      {failed ? (
        <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br p-3 ${g}`}>
          <span className="line-clamp-3 text-center text-sm font-semibold text-white/90">{title}</span>
        </div>
      ) : (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      )}
    </div>
  )
}
