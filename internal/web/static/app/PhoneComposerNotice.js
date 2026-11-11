import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'

export function PhoneComposerNotice({ path, active, enabled, canTake, onMove, onBusyChange, refresh }) {
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const taking = useRef(false)
  const inspect = useRef(null)
  const generation = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!active || !enabled) { setDraft(null); return }
    const controller = new AbortController()
    let timer
    let reading = false
    const read = async () => {
      if (reading || taking.current || controller.signal.aborted || document.hidden) return
      reading = true
      const version = generation.current
      try {
        const res = await fetch(path + '/composer', { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error?.message || 'Unable to inspect desktop draft')
        if (!controller.signal.aborted && version === generation.current && !taking.current) setDraft(data.foreign ? data : null)
      } finally { reading = false }
    }
    const poll = async () => {
      if (!document.hidden && !taking.current) {
        try { await read() } catch (_) {}
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000)
    }
    inspect.current = read
    poll()
    const resume = () => { read().catch(() => {}) }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      controller.abort(); clearTimeout(timer); inspect.current = null
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [path, active, enabled])

  useEffect(() => { if (refresh) inspect.current?.().catch(() => {}) }, [refresh])

  const take = async discard => {
    if (taking.current || !draft || !canTake || !active || !enabled) return
    if (discard && !window.confirm('Discard the unsent desktop draft?')) return
    taking.current = true; generation.current++; setBusy(true); setError('')
    onBusyChange?.(true)
    try {
      const res = await fetch(path + '/composer/take', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ fingerprint: draft.fingerprint }) })
      const data = await res.json()
      if (data.draft && (!discard || !res.ok)) onMove(data.draft)
      if (!res.ok) throw new Error(data?.error?.message || 'Unable to move desktop draft')
      if (mounted.current) setDraft(null)
    } catch (e) { if (mounted.current) setError(e.message) }
    finally {
      taking.current = false
      onBusyChange?.(false)
      if (mounted.current) setBusy(false)
      inspect.current?.().catch(() => {})
    }
  }

  if (!draft && !error) return null
  return html`<aside class="phone-desktop-draft" aria-label="Desktop draft">
    ${draft && html`<div class="phone-desktop-draft-line"><span title=${draft.draft}>Desktop has an unsent draft: ${draft.draft}</span>
      <button type="button" disabled=${busy || !enabled || !canTake} onClick=${() => take(false)}>Move here</button>
      <button type="button" disabled=${busy || !enabled || !canTake} onClick=${() => take(true)}>Discard</button></div>`}
    ${error && html`<p role="alert">${error}</p>`}
  </aside>`
}
