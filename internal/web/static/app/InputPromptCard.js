import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { authHeaders } from './api.js'

export function InputPromptCard({ path, active, interactiveMenu, enabled, canAnswer, onOpenTerminal }) {
  const [prompt, setPrompt] = useState(null)
  const [message, setMessage] = useState('')
  const [inspectionError, setInspectionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState(null)
  const attempted = useRef(new Set())
  const inFlight = useRef(false)
  const inspectNow = useRef(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!active || !interactiveMenu) {
      if (!interactiveMenu) setPrompt(null)
      return
    }
    const controller = new AbortController()
    let timer
    let reading = false
    const inspect = async () => {
      if (document.hidden || reading || controller.signal.aborted) return
      reading = true
      try {
        const res = await fetch(path + '/input-prompt', { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error?.message || 'Unable to inspect prompt')
        if (!controller.signal.aborted) { setPrompt(data); setInspectionError('') }
      } catch (e) {
        if (!controller.signal.aborted) { setInspectionError(e.message); setPrompt(null) }
      } finally {
        reading = false
      }
    }
    const poll = async () => {
      await inspect()
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000)
    }
    inspectNow.current = inspect
    poll()
    window.addEventListener('online', inspect)
    document.addEventListener('visibilitychange', inspect)
    return () => {
      controller.abort(); clearTimeout(timer); inspectNow.current = null
      window.removeEventListener('online', inspect)
      document.removeEventListener('visibilitychange', inspect)
    }
  }, [path, active, interactiveMenu])

  useLayoutEffect(() => { setConfirmation(null) }, [prompt?.prompt_id, active, interactiveMenu])

  const choose = async (option, confirmed = false) => {
    if (!active || !interactiveMenu || !enabled || !canAnswer || !prompt?.prompt_id || prompt.answered || inFlight.current || attempted.current.has(prompt.prompt_id)) return
    if (option.scope !== 'once' && option.scope !== 'deny' && !confirmed) {
      setConfirmation({ option, promptID: prompt.prompt_id })
      return
    }
    inFlight.current = true
    attempted.current.add(prompt.prompt_id)
    setBusy(true); setConfirmation(null); setMessage('Sending choice…')
    try {
      const body = { prompt_id: prompt.prompt_id, choice: option.choice }
      if (confirmed) body.confirm_scope = true
      const res = await fetch(path + '/input-prompt/choice', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) })
      const result = await res.json()
      if (!mounted.current) return
      if (result.error?.code === 'OUTCOME_UNCONFIRMED' || (result.key_sent && !result.verified)) {
        setMessage('Choice sent, but clearing was not confirmed. Do not retry. Check the live prompt or open Terminal.')
      } else if (result.error?.code === 'PROMPT_CHANGED') {
        setMessage('Prompt changed or was already answered. Review the current prompt before choosing again.')
      } else if (result.error?.code === 'NO_PROMPT') {
        setMessage('No active prompt. No key was sent.')
      } else if (!res.ok) {
        setMessage(result.error?.message || 'Unable to answer this prompt.')
      } else if (result.outcome === 'next_prompt') {
        setMessage('Choice verified. Another prompt needs a decision.')
      } else {
        setMessage('Choice verified. The original prompt cleared.')
      }
      await inspectNow.current?.()
    } catch {
      if (mounted.current) setMessage('Outcome unconfirmed. Do not retry. Check the live prompt or open Terminal.')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (!interactiveMenu && !message) return null
  const disabled = !active || !interactiveMenu || !enabled || !canAnswer || busy || prompt?.answered || attempted.current.has(prompt?.prompt_id)
  return html`<section class="input-prompt-card" aria-label="Agent input prompt">
    ${prompt?.prompt_id ? html`
      <h3>Choose an option</h3>
      <pre class="input-prompt-context">${prompt.context}</pre>
      <div class="input-prompt-options">${prompt.options.map(option => html`<button type="button" key=${option.number}
        disabled=${disabled || option.number > 9} onClick=${() => choose(option)}>${option.number}. ${option.label}</button>`)}</div>
      ${prompt.answered && !message && html`<p>Already answered. Check the live prompt before continuing.</p>`}
      ${confirmation && confirmation.promptID === prompt.prompt_id && html`<div role="group" aria-label="Confirm permission scope">
        <p>This grants ${confirmation.option.scope === 'session' ? 'permission for this session' : confirmation.option.scope === 'persistent' ? 'persistent permission' : 'the permission shown below'}. ${confirmation.option.label}</p>
        <button type="button" disabled=${disabled} onClick=${() => choose(confirmation.option, true)}>Confirm this scope</button>
        <button type="button" onClick=${() => setConfirmation(null)}>Cancel</button>
      </div>`}
      ${!canAnswer && html`<p>Answering is disabled in read-only mode or when web mutations are off.</p>`}
      ${!enabled && html`<p>Reconnect before answering.</p>`}
    ` : interactiveMenu && html`<p>${inspectionError || prompt?.reason || (prompt ? 'This menu cannot be safely answered in Chat yet.' : 'Inspecting live prompt…')}</p>`}
    ${message && html`<p role="status">${message}</p>`}
    <a href="#terminal" onClick=${e => { e.preventDefault(); onOpenTerminal?.() }}>Open Terminal</a>
  </section>`
}
