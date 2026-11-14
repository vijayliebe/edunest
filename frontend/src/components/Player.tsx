import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { Chapter, Note, Subtitle } from '../api'
import { fmtTime, isTypingTarget } from '../util'

export interface PlayerHandle {
  seek: (t: number, play?: boolean) => void
  play: () => void
  pause: () => void
  isPlaying: () => boolean
  currentTime: () => number
}

interface Props {
  src: string
  poster?: string
  startAt?: number
  durationHint?: number | null
  chapters: Chapter[]
  notes: Note[]
  subtitles: Subtitle[]
  onTime?: (t: number) => void
  onPause?: (t: number) => void
  onEnded?: () => void
  onAddNote?: () => void
  onPrev?: () => void
  onNext?: () => void
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]
const store = {
  get: (k: string, d: number) => {
    const v = Number(localStorage.getItem(`edunest.${k}`))
    return Number.isFinite(v) && localStorage.getItem(`edunest.${k}`) !== null ? v : d
  },
  set: (k: string, v: number) => localStorage.setItem(`edunest.${k}`, String(v)),
}

const Player = forwardRef<PlayerHandle, Props>(function Player(
  { src, poster, startAt = 0, durationHint, chapters, notes, subtitles, onTime, onPause, onEnded, onAddNote, onPrev, onNext },
  ref,
) {
  const wrap = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(startAt)
  const [duration, setDuration] = useState(durationHint ?? 0)
  const [buffered, setBuffered] = useState(0)
  const [rate, setRate] = useState(() => store.get('rate', 1))
  const [volume, setVolume] = useState(() => store.get('volume', 1))
  const [muted, setMuted] = useState(false)
  const [captions, setCaptions] = useState(() => store.get('captions', 0) === 1)
  const [fullscreen, setFullscreen] = useState(false)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  const [idle, setIdle] = useState(false)
  const [speedMenu, setSpeedMenu] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idleTimer = useRef<number | undefined>(undefined)
  const flashTimer = useRef<number | undefined>(undefined)

  const showFlash = (s: string) => {
    setFlash(s)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 600)
  }

  const seek = useCallback((t: number, play?: boolean) => {
    const el = video.current
    if (!el) return
    const d = el.duration || duration
    el.currentTime = Math.max(0, d ? Math.min(t, d - 0.1) : t)
    setTime(el.currentTime)
    if (play) void el.play().catch(() => {})
  }, [duration])

  const toggle = useCallback(() => {
    const el = video.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  useImperativeHandle(ref, () => ({
    seek,
    play: () => void video.current?.play().catch(() => {}),
    pause: () => video.current?.pause(),
    isPlaying: () => !!video.current && !video.current.paused,
    currentTime: () => video.current?.currentTime ?? 0,
  }), [seek])

  // New source: reset state and jump to the start position once metadata is known.
  useEffect(() => {
    setError(null)
    setTime(startAt)
    setDuration(durationHint ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  useEffect(() => {
    const el = video.current
    if (el) el.playbackRate = rate
    store.set('rate', rate)
  }, [rate, src])

  useEffect(() => {
    const el = video.current
    if (!el) return
    el.volume = volume
    el.muted = muted
    store.set('volume', volume)
  }, [volume, muted])

  useEffect(() => {
    const el = video.current
    if (!el) return
    for (const tr of Array.from(el.textTracks)) tr.mode = captions && tr === el.textTracks[0] ? 'showing' : 'hidden'
    store.set('captions', captions ? 1 : 0)
  }, [captions, subtitles, src])

  // ---- Fullscreen
  // 1. Fullscreen API on the whole player (desktop, Android, iPad) — keeps our controls & note button.
  // 2. iPhone has no Fullscreen API for elements, only the <video>'s native player (webkitEnterFullscreen).
  // 3. "Fill" mode: CSS that makes the player cover the viewport. Used when rotating a phone to
  //    landscape, because browsers only allow real fullscreen right after a tap.
  const [fill, setFill] = useState(false)
  const [nativeFs, setNativeFs] = useState(false)
  const isFull = fullscreen || fill || nativeFs

  useEffect(() => {
    const onFs = () => {
      const d = document as Document & { webkitFullscreenElement?: Element | null }
      setFullscreen((d.fullscreenElement ?? d.webkitFullscreenElement) === wrap.current)
    }
    const el = video.current
    const onBegin = () => setNativeFs(true)
    const onEnd = () => setNativeFs(false)
    document.addEventListener('fullscreenchange', onFs)
    document.addEventListener('webkitfullscreenchange', onFs)
    el?.addEventListener('webkitbeginfullscreen', onBegin)
    el?.addEventListener('webkitendfullscreen', onEnd)
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      document.removeEventListener('webkitfullscreenchange', onFs)
      el?.removeEventListener('webkitbeginfullscreen', onBegin)
      el?.removeEventListener('webkitendfullscreen', onEnd)
    }
  }, [])

  // Lock page scrolling while in fill mode
  useEffect(() => {
    if (!fill) return
    const prev = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    window.scrollTo(0, 0)
    return () => {
      document.documentElement.style.overflow = prev
    }
  }, [fill])

  const enterFullscreen = useCallback(async (fromGesture: boolean): Promise<boolean> => {
    const w = wrap.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitDisplayingFullscreen?: boolean }) | null
    if (!w || !v) return false
    try {
      if (w.requestFullscreen) {
        await w.requestFullscreen()
        return true
      }
      if (w.webkitRequestFullscreen) {
        w.webkitRequestFullscreen()
        await new Promise((r) => setTimeout(r, 300))
        if ((document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement) return true
      }
      if (v.webkitEnterFullscreen && (fromGesture || !v.paused)) {
        v.webkitEnterFullscreen() // iPhone: native player
        await new Promise((r) => setTimeout(r, 400))
        return !!v.webkitDisplayingFullscreen
      }
    } catch {
      /* not allowed without a tap, or unsupported */
    }
    return false
  }, [])

  const exitFullscreen = useCallback(() => {
    const d = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
    const v = video.current as (HTMLVideoElement & { webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean }) | null
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else if (d.webkitFullscreenElement) d.webkitExitFullscreen?.()
    if (v?.webkitDisplayingFullscreen) v.webkitExitFullscreen?.()
    setFill(false)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (isFull) exitFullscreen()
    else
      void enterFullscreen(true).then((ok) => {
        if (!ok) setFill(true)
      })
  }, [isFull, enterFullscreen, exitFullscreen])

  // Phones: rotating to landscape goes fullscreen, rotating back to portrait leaves it.
  // (Does nothing when the phone's rotation lock is on, since the page never rotates.)
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse) and (orientation: landscape) and (max-height: 540px)')
    const onChange = () => {
      if (mq.matches) {
        void enterFullscreen(false).then((ok) => {
          if (!ok) setFill(true)
        })
      } else {
        exitFullscreen()
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [enterFullscreen, exitFullscreen])

  // Keyboard shortcuts (ignored while typing in an input/textarea)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      const el = video.current
      if (!el) return
      const k = e.key
      const handled = () => e.preventDefault()
      if (e.shiftKey && k === 'N') { handled(); onNext?.() }
      else if (e.shiftKey && k === 'P') { handled(); onPrev?.() }
      else if (k === ' ' || k === 'k') { handled(); toggle() }
      else if (k === 'ArrowLeft') { handled(); seek(el.currentTime - 5); showFlash('« 5s') }
      else if (k === 'ArrowRight') { handled(); seek(el.currentTime + 5); showFlash('5s »') }
      else if (k === 'j') { handled(); seek(el.currentTime - 10); showFlash('« 10s') }
      else if (k === 'l') { handled(); seek(el.currentTime + 10); showFlash('10s »') }
      else if (k === 'ArrowUp') { handled(); setVolume((x) => Math.min(1, +(x + 0.1).toFixed(2))); setMuted(false) }
      else if (k === 'ArrowDown') { handled(); setVolume((x) => Math.max(0, +(x - 0.1).toFixed(2))) }
      else if (k === 'm') { handled(); setMuted((m) => !m) }
      else if (k === 'f') { handled(); toggleFullscreen() }
      else if (k === 'c' && subtitles.length) { handled(); setCaptions((c) => !c) }
      else if (k === '>' || k === '.') {
        handled()
        setRate((r) => { const n = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r) + 1)] ?? 1; showFlash(`${n}×`); return n })
      } else if (k === '<' || k === ',') {
        handled()
        setRate((r) => { const n = SPEEDS[Math.max(0, SPEEDS.indexOf(r) - 1)] ?? 1; showFlash(`${n}×`); return n })
      } else if (k === 'n') { handled(); onAddNote?.() }
      else if (/^[0-9]$/.test(k) && el.duration) { handled(); seek((el.duration * Number(k)) / 10) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [seek, toggle, toggleFullscreen, onAddNote, onPrev, onNext, subtitles.length])

  const poke = () => {
    setIdle(false)
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500)
  }

  const tAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (duration || 0)
  }

  const onBarDown = (e: React.PointerEvent) => {
    if (!duration) return
    e.currentTarget.setPointerCapture(e.pointerId)
    seek(tAt(e.clientX))
    const move = (ev: PointerEvent) => seek(tAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const chapterAt = useCallback(
    (t: number) => [...chapters].reverse().find((c) => t >= c.start_s) ?? null,
    [chapters],
  )
  const noteNear = (t: number) => {
    const tol = Math.max(1.5, duration / 150)
    return notes.find((n) => Math.abs(n.timestamp_s - t) <= tol) ?? null
  }

  const segments = useMemo(() => {
    if (!chapters.length || !duration) return [{ from: 0, to: 1 }]
    return chapters.map((c, i) => ({
      from: c.start_s / duration,
      to: (chapters[i + 1]?.start_s ?? c.end_s ?? duration) / duration,
    }))
  }, [chapters, duration])

  const played = duration ? time / duration : 0
  const hoverNote = hover ? noteNear(hover.t) : null
  const currentChapter = chapterAt(time)
  const showControls = !playing || !idle || speedMenu

  return (
    <div
      ref={wrap}
      className={`group select-none overflow-hidden bg-black ${
        fill ? 'fixed inset-0 z-[100] h-[100dvh] w-screen' : `relative w-full ${fullscreen ? 'h-full' : 'aspect-video'}`
      } ${showControls ? '' : 'cursor-none'}`}
      onMouseMove={poke}
      onMouseLeave={() => setIdle(true)}
    >
      <video
        ref={video}
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        className="h-full w-full"
        onClick={toggle}
        onDoubleClick={toggleFullscreen}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          setDuration(el.duration)
          el.playbackRate = rate
          if (startAt > 0 && startAt < el.duration - 1) el.currentTime = startAt
        }}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime
          setTime(t)
          onTime?.(t)
        }}
        onProgress={(e) => {
          const el = e.currentTarget
          if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1))
        }}
        onPlay={() => { setPlaying(true); poke() }}
        onPause={(e) => { setPlaying(false); onPause?.(e.currentTarget.currentTime) }}
        onEnded={() => { setPlaying(false); onEnded?.() }}
        onError={() => setError('This video could not be played in the browser (unsupported codec or container).')}
      >
        {subtitles.map((s) => (
          <track key={s.url} kind="subtitles" src={s.url} label={s.label} srcLang={s.lang} />
        ))}
      </video>

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6 text-center text-sm text-red-300">{error}</div>
      )}

      {flash && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl bg-black/60 px-4 py-2 text-lg font-semibold">
          {flash}
        </div>
      )}

      {!playing && !error && (
        <button
          onClick={toggle}
          className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 hover:bg-accent"
          aria-label="Play"
        >
          <svg viewBox="0 0 24 24" className="ml-1 h-8 w-8" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </button>
      )}

      {/* Controls */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-3 pb-2 pt-10 transition-opacity ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Seek bar with chapter segments and note markers */}
        <div
          ref={bar}
          className="relative h-5 cursor-pointer touch-none"
          onPointerDown={onBarDown}
          onMouseMove={(e) => duration && setHover({ x: e.clientX - bar.current!.getBoundingClientRect().left, t: tAt(e.clientX) })}
          onMouseLeave={() => setHover(null)}
        >
          {segments.map((s, i) => (
            <div
              key={i}
              className="absolute top-1/2 h-1 -translate-y-1/2 overflow-hidden bg-white/25 transition-[height] group-hover:h-1.5"
              style={{ left: `calc(${s.from * 100}% + ${i ? 1.5 : 0}px)`, width: `calc(${(s.to - s.from) * 100}% - ${i ? 1.5 : 0}px)` }}
            >
              <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: `${Math.max(0, Math.min(1, ((duration ? buffered / duration : 0) - s.from) / (s.to - s.from))) * 100}%` }} />
              <div className="absolute inset-y-0 left-0 bg-red-500" style={{ width: `${Math.max(0, Math.min(1, (played - s.from) / (s.to - s.from))) * 100}%` }} />
            </div>
          ))}
          {duration > 0 && notes.map((n) => (
            <button
              key={n.id}
              title={`Note at ${fmtTime(n.timestamp_s)}`}
              onPointerDown={(e) => { e.stopPropagation(); seek(n.timestamp_s, true) }}
              className="absolute top-1/2 z-10 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-note shadow ring-1 ring-black/50 hover:h-4 hover:w-1.5"
              style={{ left: `${(n.timestamp_s / duration) * 100}%` }}
            />
          ))}
          <div
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full bg-red-500 transition group-hover:scale-100"
            style={{ left: `${played * 100}%` }}
          />
          {hover && (
            <div
              className="pointer-events-none absolute bottom-6 max-w-64 -translate-x-1/2 rounded-md bg-black/90 px-2 py-1 text-center text-xs shadow-lg"
              style={{ left: Math.max(60, Math.min(hover.x, (bar.current?.clientWidth ?? 0) - 60)) }}
            >
              {chapterAt(hover.t) && <div className="font-semibold">{chapterAt(hover.t)!.title}</div>}
              <div className="font-mono">{fmtTime(hover.t)}</div>
              {hoverNote && <div className="mt-1 line-clamp-3 border-t border-white/20 pt-1 text-left text-note">✎ {hoverNote.body_md}</div>}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 text-sm">
          {onPrev && <IconBtn label="Previous lesson (Shift+P)" onClick={onPrev} d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />}
          <IconBtn label={playing ? 'Pause (k)' : 'Play (k)'} onClick={toggle} d={playing ? 'M6 5h4v14H6zm8 0h4v14h-4z' : 'M8 5v14l11-7z'} />
          {onNext && <IconBtn label="Next lesson (Shift+N)" onClick={onNext} d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />}

          <div className="group/vol flex items-center">
            <IconBtn
              label="Mute (m)"
              onClick={() => setMuted((m) => !m)}
              d={muted || volume === 0 ? 'M16.5 12 19 9.5 17.5 8 15 10.5 12.5 8 11 9.5l2.5 2.5-2.5 2.5 1.5 1.5 2.5-2.5 2.5 2.5 1.5-1.5zM3 9v6h4l5 5V4L7 9z' : 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z'}
            />
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false) }}
              className="slim w-0 opacity-0 transition-all group-hover/vol:w-20 group-hover/vol:opacity-100"
              aria-label="Volume"
            />
          </div>

          <span className="ml-2 whitespace-nowrap font-mono text-xs tabular-nums text-white/90">
            {fmtTime(time)} / {fmtTime(duration)}
          </span>
          {currentChapter && (
            <span className="ml-2 hidden truncate text-xs text-white/70 sm:inline">· {currentChapter.title}</span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {onAddNote && (
              <button
                onClick={onAddNote}
                title="Add note at current time (n)"
                className="flex items-center gap-1 rounded-full bg-note/90 px-3 py-1 text-xs font-semibold text-black hover:bg-note"
              >
                ✎ Note
              </button>
            )}
            {subtitles.length > 0 && (
              <button
                onClick={() => setCaptions((c) => !c)}
                title="Subtitles (c)"
                className={`rounded px-1.5 py-0.5 text-xs font-bold ${captions ? 'bg-white text-black' : 'border border-white/60 text-white'}`}
              >
                CC
              </button>
            )}
            <div className="relative">
              <button onClick={() => setSpeedMenu((s) => !s)} title="Playback speed (< >)" className="rounded px-2 py-1 font-mono text-xs hover:bg-white/15">
                {rate}×
              </button>
              {speedMenu && (
                <div className="absolute bottom-9 right-0 z-20 rounded-lg bg-black/95 py-1 shadow-xl ring-1 ring-white/10">
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      onClick={() => { setRate(s); setSpeedMenu(false) }}
                      className={`block w-full px-5 py-1 text-right font-mono text-xs hover:bg-white/10 ${s === rate ? 'text-accent-2' : ''}`}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              )}
            </div>
            <IconBtn
              label={isFull ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
              onClick={toggleFullscreen}
              d={isFull ? 'M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z' : 'M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z'}
            />
          </div>
        </div>
      </div>
    </div>
  )
})

function IconBtn({ label, onClick, d }: { label: string; onClick: () => void; d: string }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className="rounded-full p-1.5 hover:bg-white/15">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor"><path d={d} /></svg>
    </button>
  )
}

export default Player
