import { useCallback, useEffect, useState } from 'react'

/** 754 -> "12:34", 3754 -> "1:02:34" */
export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return '0:00'
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 5400 -> "1h 30m", 300 -> "5m" */
export function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  return m ? `${m}m` : `${Math.round(sec)}s`
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0
}

/** Tiny data hook: { data, error, loading, reload, setData } */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps)
  const reload = useCallback(() => {
    setLoading(true)
    return load()
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [load])
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, loading, reload, setData }
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}
