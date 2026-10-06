// All talk with the AudioLDM API lives here.
const BASE = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '')

async function request(path, options = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, options)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    console.error('[blooplayground] network error', err)
    throw new Error("can't reach the playground right now.")
  }

  const data = await res.json().catch(() => null)

  if (res.status === 429) {
    const err = new Error('the playground is full right now. try again in a moment.')
    err.code = 'queue-full'
    throw err
  }

  if (!res.ok) {
    console.error('[blooplayground] api error', res.status, data)
    const err = new Error(data?.error || 'the playground hiccuped. try again?')
    if (res.status === 404) err.code = 'not-found'
    throw err
  }

  return data
}

// 202 -> { status, id, queue_position, status_url } | 429 -> queue full
export function generate(params) {
  return request('/api/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

// { id, status, queue_position?, audio_url?, finished_at?, error? }
export function getJob(id, signal) {
  return request(`/api/v1/jobs/${encodeURIComponent(id)}`, { signal })
}

// { status, queued, processing, total, max_queue_size, available_slots }
export function getQueue(signal) {
  return request('/api/v1/queue', { signal })
}

// { status, count, retention_hours, history: [{ id, prompt, audio_url, finished_at, ... }] }
export function getHistory(signal) {
  return request('/api/v1/history', { signal })
}

// audio_url is relative when the API has no PUBLIC_BASE_URL configured.
export function absoluteUrl(url) {
  return url && url.startsWith('/') ? `${BASE}${url}` : url
}

// Browsers ignore the `download` attribute on cross-origin links, so fetch the
// file and hand it over as a blob instead.
export async function downloadAudio(url, name) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const objectUrl = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = name
    a.click()
    URL.revokeObjectURL(objectUrl)
  } catch (err) {
    console.error('[blooplayground] download failed', err)
    window.open(url, '_blank', 'noopener')
  }
}
