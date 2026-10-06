import { useCallback, useEffect, useRef, useState } from 'react'
import {
  generate,
  getJob,
  getQueue,
  getHistory,
  absoluteUrl,
  downloadAudio,
} from './api.js'
import PROMPTS from './prompts.json'

const MAX = 500
const QUEUE_INTERVAL = 8000
const HISTORY_INTERVAL = 15000
const HISTORY_LIMIT = 25

const DEFAULTS = {
  translate: true,
  enhance: true,
  source_language: 'auto',
  duration: 5,
  steps: 50,
  guidance_scale: 2.5,
  seed: 42,
}

// FLORES-200 codes; "auto" lets the API detect the language itself.
const LANGUAGES = [
  ['auto', 'auto-detect'],
  ['eng_Latn', 'english'],
  ['ind_Latn', 'indonesian'],
  ['jav_Latn', 'javanese'],
  ['sun_Latn', 'sundanese'],
  ['zsm_Latn', 'malay'],
]

const DURATIONS = [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20]

const BTN =
  'inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100'
const PRIMARY = `${BTN} bg-ink text-cream hover:bg-ink/90`
const GHOST = `${BTN} border border-line text-soft hover:border-ink hover:text-ink`
const INPUT = 'rounded-lg border border-line bg-paper px-2.5 py-1.5 text-sm focus:border-ink'
const LINK = 'underline decoration-bloop decoration-2 underline-offset-4'

// A refresh mid-generation shouldn't lose the job — remember it and resume polling.
const STORAGE_KEY = 'blooplayground.job'
const RESUME_MAX_AGE = 2 * 60 * 60 * 1000

function loadSavedJob() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return saved && typeof saved.id === 'string' ? saved : null
  } catch {
    return null
  }
}

function saveJob(job) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(job))
  } catch {
    // private mode or storage disabled: resuming just won't work
  }
}

function clearSavedJob() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // nothing to clean up
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

// playful nudge without remounting the textarea (which would drop focus)
function bounce(el) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  el.animate(
    [{ transform: 'scale(0.985)' }, { transform: 'scale(1.008)' }, { transform: 'scale(1)' }],
    { duration: 280, easing: 'ease-out' },
  )
}

function fmt(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function ago(timestamp) {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function buildPayload(prompt, params) {
  return {
    prompt: prompt.trim(),
    translate: params.translate,
    enhance: params.enhance,
    source_language: params.source_language,
    duration: params.duration,
    steps: clamp(Math.round(params.steps) || DEFAULTS.steps, 10, 200),
    guidance_scale: clamp(Number(params.guidance_scale) || DEFAULTS.guidance_scale, 1, 10),
    seed: Number.isFinite(params.seed) ? Math.trunc(params.seed) : DEFAULTS.seed,
  }
}

// One <audio> for the whole page, so a result and a history row never overlap.
function usePlayer() {
  const ref = useRef(null)
  const [currentId, setCurrentId] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const toggle = useCallback(
    (id, src) => {
      const audio = ref.current
      if (!audio) return
      if (currentId === id) {
        if (audio.paused) audio.play().catch(() => {})
        else audio.pause()
        return
      }
      audio.src = src
      setCurrentId(id)
      setTime(0)
      setDuration(0)
      audio.play().catch(() => {})
    },
    [currentId],
  )

  const seek = useCallback((value) => {
    const audio = ref.current
    if (!audio) return
    audio.currentTime = value
    setTime(value)
  }, [])

  const audioProps = {
    ref,
    preload: 'metadata',
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e) => setTime(e.target.currentTime),
    onLoadedMetadata: (e) => setDuration(e.target.duration),
  }

  return { audioProps, currentId, playing, time, duration, toggle, seek }
}

export default function App() {
  const [prompt, setPrompt] = useState('')
  const [params, setParams] = useState(DEFAULTS)
  const [phase, setPhase] = useState('idle')
  const [jobId, setJobId] = useState(null)
  const [queuePos, setQueuePos] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [queue, setQueue] = useState(null)
  const [history, setHistory] = useState([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [progress, setProgress] = useState(null)
  const [elapsed, setElapsed] = useState(0)

  const inputRef = useRef(null)
  const startedAt = useRef(0)
  const player = usePlayer()

  const busy = phase === 'submitting' || phase === 'queued' || phase === 'processing'
  const canGo = prompt.trim().length > 0 && !busy
  const set = (patch) => setParams((prev) => ({ ...prev, ...patch }))

  // one timer that survives the submitting -> queued -> processing handoffs
  useEffect(() => {
    if (!busy) {
      setElapsed(0)
      return
    }
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [busy])

  // pick up an in-flight job saved before the page was refreshed
  useEffect(() => {
    const saved = loadSavedJob()
    if (!saved) return
    if (saved.startedAt && Date.now() - saved.startedAt > RESUME_MAX_AGE) {
      clearSavedJob()
      return
    }
    startedAt.current = saved.startedAt || Date.now()
    setPrompt(saved.prompt || '')
    setJobId(saved.id)
    setPhase('queued')
  }, [])

  // queue heartbeat
  useEffect(() => {
    const ctrl = new AbortController()
    const tick = () => getQueue(ctrl.signal).then(setQueue).catch(() => {})
    tick()
    const t = setInterval(tick, QUEUE_INTERVAL)
    return () => {
      clearInterval(t)
      ctrl.abort()
    }
  }, [])

  const refreshHistory = useCallback(() => {
    return getHistory()
      .then((data) => {
        const items = Array.isArray(data?.history) ? data.history : []
        setHistory(items.slice().sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0)))
        setHistoryLoaded(true)
      })
      .catch(() => {})
  }, [])

  // history heartbeat
  useEffect(() => {
    refreshHistory()
    const t = setInterval(refreshHistory, HISTORY_INTERVAL)
    return () => clearInterval(t)
  }, [refreshHistory])

  // poll the job until it finishes
  useEffect(() => {
    if (!jobId) return
    const ctrl = new AbortController()
    let alive = true

    ;(async () => {
      let delay = 2000
      let misses = 0
      while (alive) {
        try {
          await sleep(delay, ctrl.signal)
        } catch {
          return
        }

        let job
        try {
          job = await getJob(jobId, ctrl.signal)
          misses = 0
        } catch (err) {
          if (err.name === 'AbortError' || !alive) return
          if (err.code === 'not-found') {
            // pruned after a restart, or older than the API keeps jobs
            clearSavedJob()
            setError('that sound got lost in the shuffle. try it again?')
            setPhase('error')
            return
          }
          // a blip on a minutes-long job shouldn't lose it
          if (++misses >= 3) {
            setError('lost touch with the playground. try again?')
            setPhase('error')
            return
          }
          delay = 2500
          continue
        }
        if (!alive) return

        if (job.status === 'completed') {
          setResult(job)
          setPhase('done')
          setProgress(null)
          clearSavedJob()
          refreshHistory()
          return
        }
        if (job.status === 'failed') {
          console.error('[blooplayground] job failed', job.detail || job.error)
          clearSavedJob()
          setError("bloop couldn't make that one. try a different sound?")
          setPhase('error')
          return
        }

        setPhase(job.status)
        setProgress(job.progress || null)
        if (job.status === 'queued') setQueuePos(job.queue_position ?? 0)
        delay = Math.min(delay + 1000, 5000)
      }
    })()

    return () => {
      alive = false
      ctrl.abort()
    }
  }, [jobId, refreshHistory])

  async function submit(e) {
    e?.preventDefault()
    if (!canGo) return
    setResult(null)
    setError(null)
    setQueuePos(null)
    setProgress(null)
    setJobId(null)
    setPhase('submitting')
    startedAt.current = Date.now()
    try {
      const job = await generate(buildPayload(prompt, params))
      setQueuePos(job.queue_position ?? 0)
      setJobId(job.id)
      setPhase('queued')
      saveJob({ id: job.id, prompt: prompt.trim(), startedAt: startedAt.current })
    } catch (err) {
      clearSavedJob()
      setError(err.message)
      setPhase('error')
    }
  }

  function randomize() {
    if (busy) return
    let next = prompt
    while (next === prompt && PROMPTS.length > 1) {
      next = PROMPTS[Math.floor(Math.random() * PROMPTS.length)]
    }
    setPrompt(next)
    inputRef.current?.focus()
    bounce(inputRef.current)
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function reset() {
    setPhase('idle')
    setResult(null)
    setError(null)
    setJobId(null)
    setQueuePos(null)
    clearSavedJob()
    inputRef.current?.focus()
  }

  const label =
    {
      submitting: 'sending…',
      queued: 'in line…',
      processing: 'cooking…',
      error: 'try again',
    }[phase] || 'generate'

  // progress arrives from GET /api/v1/jobs/<id> while the sampler runs
  const sampling =
    phase === 'processing' && progress?.stage === 'ddim_sampling' && progress.total_steps > 0
  const percent = sampling ? clamp(progress.percent || 0, 0, 100) : null

  let detail
  if (sampling) {
    detail = `step ${progress.completed_steps}/${progress.total_steps} · ${Math.round(percent)}% · ${elapsed}s`
  } else if (phase === 'processing') {
    detail = `getting the models ready… ${elapsed}s`
  } else if (phase === 'queued' && queuePos >= 3) {
    detail = `the playground is busy right now. ${elapsed}s`
  } else {
    detail = `this can take a minute or two. ${elapsed}s`
  }

  return (
    <main className="flex min-h-dvh flex-col items-center px-5 py-12 sm:py-20">
      <div className="w-full max-w-xl">
        <header className="mb-9">
          <QueueChip queue={queue} />
          <h1 className="text-3xl font-bold tracking-tight lowercase sm:text-4xl">
            blooplayground
            <span
              aria-hidden="true"
              className={`ml-1.5 inline-block size-2.5 rounded-full align-middle transition-colors ${
                busy ? 'animate-pulse bg-bloop' : phase === 'done' ? 'bg-bloop' : 'bg-line'
              }`}
            />
          </h1>
          <p className="mt-2 text-soft">make some weird sounds.</p>
        </header>

        <form onSubmit={submit}>
          <label htmlFor="prompt" className="sr-only">
            describe a sound
          </label>
          <textarea
            id="prompt"
            ref={inputRef}
            rows={3}
            maxLength={MAX}
            value={prompt}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="a broken arcade machine playing music..."
            className="w-full resize-none rounded-2xl border border-line bg-paper px-4 py-3.5 text-base leading-relaxed placeholder:text-soft/60 transition-colors focus:border-ink disabled:opacity-60"
          />
          <div className="flex h-3 items-center justify-end">
            {prompt.length > MAX * 0.7 && (
              <span className="text-xs tabular-nums text-soft">
                {prompt.length}/{MAX}
              </span>
            )}
          </div>

          <details className="mb-5 rounded-2xl border border-line bg-paper/60 px-4 py-3">
            <summary className="cursor-pointer select-none text-sm text-soft">
              more knobs
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
              <Field label="translate" hint="prompt → english">
                <Toggle
                  checked={params.translate}
                  disabled={busy}
                  onChange={(v) => set({ translate: v })}
                />
              </Field>
              <Field label="enhance" hint="adds recording detail">
                <Toggle
                  checked={params.enhance}
                  disabled={busy}
                  onChange={(v) => set({ enhance: v })}
                />
              </Field>
              <Field label="language">
                <select
                  value={params.source_language}
                  disabled={busy}
                  onChange={(e) => set({ source_language: e.target.value })}
                  className={INPUT}
                >
                  {LANGUAGES.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="duration">
                <select
                  value={params.duration}
                  disabled={busy}
                  onChange={(e) => set({ duration: Number(e.target.value) })}
                  className={INPUT}
                >
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}s
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="steps" hint="10-200">
                <input
                  type="number"
                  min={10}
                  max={200}
                  step={1}
                  value={params.steps}
                  disabled={busy}
                  onChange={(e) => set({ steps: Number(e.target.value) })}
                  className={INPUT}
                />
              </Field>
              <Field label="seed">
                <input
                  type="number"
                  step={1}
                  value={params.seed}
                  disabled={busy}
                  onChange={(e) => set({ seed: Number(e.target.value) })}
                  className={INPUT}
                />
              </Field>
              <Field label={`guidance · ${params.guidance_scale}`} className="col-span-2 sm:col-span-3">
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={0.1}
                  value={params.guidance_scale}
                  disabled={busy}
                  onChange={(e) => set({ guidance_scale: Number(e.target.value) })}
                  className="w-full accent-bloop"
                />
              </Field>
            </div>
            <div className="text-end mt-3 mb-1">
              <button
                type="button"
                onClick={() => setParams(DEFAULTS)}
                className="text-xs text-soft underline decoration-line decoration-2 underline-offset-4 hover:text-ink"
              >
                reset knobs
              </button>
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={!canGo} className={PRIMARY}>
              {label}
            </button>
            <button type="button" onClick={randomize} disabled={busy} className={GHOST}>
              <span aria-hidden="true">🎲</span> randomize
            </button>
          </div>
        </form>

        <div aria-live="polite">
          {busy && (
            <section className="fade-up mt-7">
              {percent !== null && (
                <div
                  aria-hidden="true"
                  className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-line"
                >
                  <div
                    className="h-full rounded-full bg-bloop transition-[width] duration-700 ease-out"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
              <div className="flex items-center gap-4">
                <Eq />
                <div className="min-w-0">
                  <p>
                    {phase === 'submitting' && 'waking bloop up…'}
                    {phase === 'queued' &&
                      (queuePos > 0
                        ? `your sound is in line — ${queuePos} ahead of you.`
                        : 'your sound is next in line.')}
                    {phase === 'processing' && 'bloop is cooking…'}
                  </p>
                  <p aria-hidden="true" className="mt-0.5 text-sm tabular-nums text-soft">
                    {detail}
                  </p>
                </div>
              </div>
            </section>
          )}

          {phase === 'error' && error && (
            <section
              role="alert"
              className="fade-up mt-7 rounded-2xl border border-line bg-paper px-4 py-3"
            >
              <p>{error}</p>
              <button type="button" onClick={submit} className={`mt-1 text-sm font-medium ${LINK}`}>
                try again
              </button>
            </section>
          )}

          {phase === 'done' && result && (
            <section className="fade-up mt-7">
              <Artifact job={result} player={player} />
              <p className="mt-4 text-sm text-soft">
                want another one?{' '}
                <button
                  type="button"
                  onClick={reset}
                  className={`font-medium text-ink ${LINK}`}
                >
                  try a new sound
                </button>
              </p>
            </section>
          )}
        </div>

        <History items={history} loaded={historyLoaded} player={player} />

        <audio {...player.audioProps} />

        <footer className="mt-16 text-xs text-soft/80">
          sounds by AudioLDM · no accounts, nothing saved about you
        </footer>
      </div>
    </main>
  )
}

function QueueChip({ queue }) {
  if (!queue) return null

  const total = queue.total ?? 0
  const max = queue.max_queue_size ?? 0
  const slots = queue.available_slots ?? 0

  const [text, tone, dot] =
    total === 0
      ? ['the playground is quiet right now', 'border-line text-soft', 'bg-soft/50']
      : slots === 0
        ? ['the playground is full right now', 'border-bloop/40 text-ink', 'bg-bloop']
        : [
            `${total} ${total === 1 ? 'sound' : 'sounds'} in the works`,
            'border-line text-ink',
            'bg-bloop',
          ]

  return (
    <p
      className={`mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${tone}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {text}
      <span aria-hidden="true" className="text-soft/50">
        ·
      </span>
      <span className="tabular-nums" title={`${total} of ${max} slots in use`}>
        {total}/{max}
      </span>
    </p>
  )
}

function Field({ label, hint, className = '', children }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[11px] uppercase tracking-wider text-soft">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-soft/70">{hint}</span>}
    </label>
  )
}

function Toggle({ checked, disabled, onChange }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="size-5 accent-bloop"
    />
  )
}

function Eq() {
  return (
    <div className="flex h-8 items-end gap-[3px]" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="eq-bar h-full w-1.5 rounded-full bg-bloop"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </div>
  )
}

function Artifact({ job, player }) {
  const src = absoluteUrl(job.audio_url || job.audio_path)
  const name = `blooplayground-${String(job.id).slice(0, 8)}.wav`
  const isCurrent = player.currentId === job.id
  const translated =
    job.translated_prompt && job.translated_prompt !== job.prompt ? job.translated_prompt : null

  return (
    <article className="rounded-2xl border border-line bg-paper p-4 sm:p-5">
      <p className="text-[11px] uppercase tracking-widest text-soft">your sound</p>
      <p className="mt-1 font-medium">{job.prompt}</p>
      {translated && <p className="mt-0.5 text-sm text-soft">heard as “{translated}”</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => player.toggle(job.id, src)}
          aria-label={isCurrent && player.playing ? 'pause' : 'play'}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-ink text-cream transition hover:bg-ink/90 active:scale-95"
        >
          <Icon playing={isCurrent && player.playing} />
        </button>

        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={(isCurrent ? player.duration : job.duration) || 0}
            step={0.01}
            value={isCurrent ? player.time : 0}
            disabled={!isCurrent}
            onChange={(e) => player.seek(Number(e.target.value))}
            aria-label="seek"
            className="w-full accent-bloop disabled:opacity-60"
          />
          <div className="flex justify-between text-xs tabular-nums text-soft">
            <span>{fmt(isCurrent ? player.time : 0)}</span>
            <span>{fmt(isCurrent ? player.duration : job.duration)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-soft">
        <span>
          {job.duration}s · {job.steps} steps · made in {Math.round(job.generation_time_seconds)}s
        </span>
        <button
          type="button"
          onClick={() => downloadAudio(src, name)}
          className={`font-medium text-ink ${LINK}`}
        >
          download .wav
        </button>
      </div>
    </article>
  )
}

function History({ items, loaded, player }) {
  const shown = items.slice(0, HISTORY_LIMIT)

  return (
    <section className="mt-14">
      <h2 className="text-[11px] uppercase tracking-widest text-soft">
        recent sounds · last 24h
      </h2>

      {!loaded && <p className="mt-3 text-sm text-soft">looking around…</p>}

      {loaded && items.length === 0 && (
        <p className="mt-3 text-sm text-soft">nothing here yet. you could be the first.</p>
      )}

      {shown.length > 0 && (
        <>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {shown.map((item) => {
              const src = absoluteUrl(item.audio_url || item.audio_path)
              const isCurrent = player.currentId === item.id
              return (
                <li key={item.id} className="flex items-center gap-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => player.toggle(item.id, src)}
                    aria-label={
                      isCurrent && player.playing ? `pause ${item.prompt}` : `play ${item.prompt}`
                    }
                    className="grid size-8 shrink-0 place-items-center rounded-full border border-line text-ink transition hover:border-ink active:scale-95"
                  >
                    <Icon playing={isCurrent && player.playing} size={14} />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-sm" title={item.prompt}>
                    {item.prompt}
                  </span>
                  <time className="shrink-0 text-xs text-soft">{ago(item.finished_at)}</time>
                  <button
                    type="button"
                    onClick={() =>
                      downloadAudio(src, `blooplayground-${String(item.id).slice(0, 8)}.wav`)
                    }
                    className="shrink-0 text-xs text-soft underline decoration-line decoration-2 underline-offset-4 hover:text-ink"
                  >
                    download
                  </button>
                </li>
              )
            })}
          </ul>
          {items.length > shown.length && (
            <p className="mt-2 text-xs text-soft">
              showing the latest {shown.length} of {items.length}.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function Icon({ playing, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {playing ? (
        <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" />
      ) : (
        <path d="M8 4.5v15l12-7.5z" />
      )}
    </svg>
  )
}
