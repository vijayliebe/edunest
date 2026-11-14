import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, UNAUTHORIZED_EVENT, type Me } from './api'

interface AuthCtx {
  user: Me
  logout: () => Promise<void>
}

const Ctx = createContext<AuthCtx | null>(null)
export const useAuth = () => useContext(Ctx)!

/** Renders the app only for a logged-in user; everything else sees the login screen. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ loading: boolean; user: Me | null }>({ loading: true, user: null })

  useEffect(() => {
    api
      .me()
      .then((user) => setState({ loading: false, user }))
      .catch(() => setState({ loading: false, user: null }))
    const onUnauthorized = () => setState({ loading: false, user: null })
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  const logout = useCallback(async () => {
    await api.logout().catch(() => {})
    setState({ loading: false, user: null })
  }, [])

  if (state.loading) return <div className="flex h-full items-center justify-center text-muted">Loading…</div>
  if (!state.user) return <Login onLogin={(user) => setState({ loading: false, user })} />
  return <Ctx.Provider value={{ user: state.user, logout }}>{children}</Ctx.Provider>
}

function Login({ onLogin }: { onLogin: (u: Me) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 shadow-xl"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            onLogin(await api.login(username.trim(), password))
          } catch (err) {
            setError((err as Error).message)
            setPassword('')
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="mb-6 flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <h1 className="text-xl font-semibold">EduNest</h1>
        </div>
        <label className="block text-sm font-medium" htmlFor="u">Username</label>
        <input
          id="u"
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
        />
        <label className="mt-4 block text-sm font-medium" htmlFor="p">Password</label>
        <input
          id="p"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent"
        />
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          disabled={busy || !username.trim() || !password}
          className="mt-6 w-full rounded-full bg-white py-2 font-semibold text-black hover:bg-white/90 disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
