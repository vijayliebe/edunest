export default function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-1 w-full overflow-hidden bg-white/15 ${className}`}>
      <div className="h-full bg-red-500" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}
