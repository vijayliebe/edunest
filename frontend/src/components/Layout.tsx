import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import { api, type ScanStatus } from '../api'
import { useAuth } from '../auth'

export interface LayoutCtx {
  /** Bumps every time a library scan finishes, so pages can reload. */
  scanVersion: number
  scan: ScanStatus | null
  startScan: (force?: boolean) => Promise<void>
}

export const useLayout = () => useOutletContext<LayoutCtx>()

export default function Layout() {
  const { user, logout } = useAuth()
  const [alert, setAlert] = useState<string[] | null>(null)
  const [scan, setScan] = useState<ScanStatus | null>(null)
  const [scanVersion, setScanVersion] = useState(0)
  const wasRunning = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  const poll = useCallback(async () => {
    window.clearTimeout(timer.current)
    try {
      const s = await api.scanStatus()
      setScan(s)
      if (wasRunning.current && !s.running) setScanVersion((v) => v + 1)
      wasRunning.current = s.running
      if (s.running) timer.current = window.setTimeout(poll, 1500)
    } catch {
      timer.current = window.setTimeout(poll, 5000)
    }
  }, [])

  useEffect(() => {
    void poll()
    return () => window.clearTimeout(timer.current)
  }, [poll])

  // Admins: poll the security log summary and show a warning badge when something keeps happening
  useEffect(() => {
    if (!user.is_admin) return
    const check = () => api.securitySummary().then((s) => setAlert(s.alert ? s.reasons : null)).catch(() => {})
    void check()
    const t = window.setInterval(check, 60_000)
    return () => window.clearInterval(t)
  }, [user.is_admin])

  const startScan = useCallback(
    async (force = false) => {
      await api.rescan(force)
      wasRunning.current = true
      void poll()
    },
    [poll],
  )

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-line bg-bg/90 px-4 backdrop-blur">
        <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="hidden sm:inline">EduNest</span>
        </Link>
        <SearchBox />
        <div className="ml-auto flex items-center gap-1">
          {scan?.running && (
            <span className="mr-2 hidden items-center gap-2 text-xs text-muted md:flex">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent-2" />
              Scanning {scan.processed}/{scan.total || '…'}
            </span>
          )}
          {alert && (
            <Link
              to="/settings#security"
              title={alert.join('\n')}
              className="mr-1 flex items-center gap-1.5 rounded-full bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/30"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="hidden sm:inline">Suspicious activity</span>
            </Link>
          )}
          {user.is_admin && (
          <button
            onClick={() => void startScan()}
            disabled={scan?.running}
            title="Rescan library folders"
            className="rounded-full p-2 text-muted hover:bg-white/10 hover:text-white disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className={`h-5 w-5 ${scan?.running ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          )}
          {user.is_admin && (
          <NavLink
            to="/settings"
            title="Settings"
            className={({ isActive }) => `rounded-full p-2 hover:bg-white/10 hover:text-white ${isActive ? 'text-white' : 'text-muted'}`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </NavLink>
          )}
          <button
            onClick={() => void logout()}
            title={`Signed in as ${user.username} — sign out`}
            className="ml-1 flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 text-xs text-muted hover:bg-white/10 hover:text-white"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[11px] font-bold uppercase text-white">
              {user.username.slice(0, 1)}
            </span>
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>
      <main className="flex-1">
        <Outlet context={{ scanVersion, scan, startScan } satisfies LayoutCtx} />
      </main>
    </div>
  )
}

function SearchBox() {
  const nav = useNavigate()
  const loc = useLocation()
  const [params] = useSearchParams()
  const [q, setQ] = useState('')
  useEffect(() => {
    setQ(loc.pathname === '/search' ? (params.get('q') ?? '') : '')
  }, [loc.pathname, params])

  return (
    <form
      className="mx-auto flex w-full max-w-xl"
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`)
      }}
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search courses, lessons and your notes"
        className="w-full rounded-l-full border border-line bg-panel px-4 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
      />
      <button className="rounded-r-full border border-l-0 border-line bg-panel-2 px-4 text-muted hover:text-white" title="Search">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
      </button>
    </form>
  )
}
