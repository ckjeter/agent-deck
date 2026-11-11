import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { apiFetch, authHeaders } from './api.js'
import { renderMarkdown } from './miniMarkdown.js'
import { InputPromptCard } from './InputPromptCard.js'
import { PhoneComposerNotice } from './PhoneComposerNotice.js'

function mergeMessages(old, incoming, removed = []) {
  const rows = new Map(old.map(row => [row.id, row]))
  for (const id of removed) rows.delete(id)
  for (const row of incoming) {
    const previous = rows.get(row.id)
    const merged = { ...previous, ...row }
    if (previous?.tool || row.tool) merged.tool = { ...previous?.tool, ...row.tool }
    rows.set(row.id, merged)
  }
  return [...rows.values()]
}

function deliveryLabel(send) {
  if (send.state === 'queued') return 'queued · session is busy, will send when idle'
  if (send.state === 'typed' && send.settled) return 'not confirmed'
  if (send.state === 'typed') return 'typed · submission unconfirmed'
  return send.state + (send.reason ? ' · ' + send.reason : '') + (send.settled ? ' · delivery watch ended' : '')
}

// A finished send that never landed: the worker will not touch it again.
const dismissable = send => send.state !== 'landed' && (send.settled || send.state === 'failed' || send.state === 'cancelled')

// The idempotency key of the message being sent, kept with its text so a
// retry after a lost response or a reload reuses it and is not queued twice.
const sendKeyPrefix = 'agentdeck.sendKey.v1:'
function sendKeyFor(path, text) {
  try {
    const saved = JSON.parse(localStorage.getItem(sendKeyPrefix + path))
    if (saved?.text === text && typeof saved.key === 'string') return saved.key
  } catch (_) {}
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  try { localStorage.setItem(sendKeyPrefix + path, JSON.stringify({ text, key })) } catch (_) {}
  return key
}
function clearSendKey(path) { try { localStorage.removeItem(sendKeyPrefix + path) } catch (_) {} }

const SEND_TIMEOUT_MS = 15000

const TOOL_ICONS = { bash: '>', edit: '±', read: 'R', subagent: '@', todo: '#', question: '?', skill: 'S', thinking: '…', tool: 'T' }

function segmentChatRows(rows) {
  const segments = []
  for (const row of rows) {
    const last = segments[segments.length - 1]
    if (row.tools) {
      if (last?.tools) last.rows.push(row)
      else segments.push({ tools: true, rows: [row] })
    } else segments.push({ tools: false, rows: [row] })
  }
  return segments
}

function toolGroupSummary(steps) {
  const definitions = [
    ['bash', 'ran', 'command'], ['edit', 'edited', 'file'], ['read', 'read', 'file'],
    ['subagent', 'launched', 'agent'], ['todo', 'updated', 'task list'],
    ['question', 'asked', 'question'], ['skill', 'used', 'skill'], ['tool', 'used', 'tool'],
  ]
  const parts = []
  for (const [kind, verb, noun] of definitions) {
    const count = steps.filter(step => (step.tool?.kind || 'tool') === kind).length
    if (count) parts.push(`${verb} ${count} ${noun}${count === 1 ? '' : 's'}`)
  }
  if (steps.some(step => step.tool?.kind === 'thinking')) parts.push('thinking')
  if (!parts.length) return `${steps.length} steps`
  const summary = parts.join(', ')
  return summary[0].toUpperCase() + summary.slice(1)
}

function toolResult(tool) {
  if (tool.kind === 'edit' && (tool.added != null || tool.removed != null)) return `+${tool.added ?? 0} / -${tool.removed ?? 0}`
  if (tool.result) return tool.result
  if (tool.is_error) return 'Error'
  if (tool.finished === false) return 'Running'
  return ''
}

function ToolStepGroup({ steps, live }) {
  const [open, setOpen] = useState(false)
  const latest = steps[steps.length - 1].tool || { kind: 'tool', title: 'Tool activity' }
  const summary = toolGroupSummary(steps)
  return html`<div class="session-tool-group">
    <button type="button" class="session-tool-summary" aria-expanded=${open} onClick=${() => setOpen(!open)}>
      <span class="session-tool-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
      <span class="session-tool-summary-text" title=${summary}>${summary}</span>
      ${live && html`<span class="session-tool-live"><span class="session-tool-live-dot" role="img" aria-label="Live tool activity"></span><span>${latest.title}</span></span>`}
    </button>
    ${open && html`<ol class="session-tool-steps">${steps.map(step => {
      const tool = step.tool || { kind: 'tool', title: 'Tool activity' }
      const result = toolResult(tool)
      return html`<li key=${step.id} data-message-id=${step.id} data-kind=${tool.kind || 'tool'}>
        <span class="session-tool-icon" aria-hidden="true">${TOOL_ICONS[tool.kind] || TOOL_ICONS.tool}</span>
        <div><span class="session-tool-label">${tool.title}</span>
          ${tool.target && html`<span class="session-tool-target" title=${tool.target}>${tool.target}</span>`}
          ${tool.detail && html`<p class="session-tool-thinking">${tool.detail}</p>`}
        </div>
        ${result && html`<span class="session-tool-result" title=${result}>${result}</span>`}
      </li>`
    })}</ol>`}
  </div>`
}

export function SessionChat({ sessionId, active = true, enabled = true, initialText = '', onTextChange, endpoint, remote = false, bottomLeft, mobileComposer = false, sessionStatus = '', interactiveMenu = false, onOpenTerminal }) {
  const [latestOnly, setLatestOnly] = useState(false)
  const [messages, setMessages] = useState([])
  const [sends, setSends] = useState([])
  const [before, setBefore] = useState('')
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deliveryError, setDeliveryError] = useState('')
  const [text, setText] = useState(initialText)
  const currentText = useRef(text)
  currentText.current = text
  const [focused, setFocused] = useState(false)
  const input = useRef(null)
  const [status, setStatus] = useState('')
  const [sending, setSending] = useState(false)
  const [composerRefresh, setComposerRefresh] = useState(0)
  const [movingDraft, setMovingDraft] = useState(false)
  const draftAction = useRef(false)
  const [canSend, setCanSend] = useState(false)
  const version = useRef('')
  const sendVersion = useRef('')
  const remoteSends = useRef(new Set())
  const through = useRef('')
  const inFlight = useRef(false)
  const output = useRef(null)
  const stickToBottom = useRef(true)
  const wasActive = useRef(false)
  const prepend = useRef(null)
  const earlierRequest = useRef(null)
  const path = endpoint || '/api/sessions/' + encodeURIComponent(sessionId)

  const expanded = focused || !!text || !!status || !!deliveryError

  useLayoutEffect(() => {
    const el = input.current
    if (!mobileComposer || !active || !el) return
    el.style.height = 'auto'
    if (text) el.style.height = el.scrollHeight + 'px'
  }, [text, expanded, mobileComposer, active, canSend])

  const resetHistory = () => {
    earlierRequest.current?.abort()
    earlierRequest.current = null
    prepend.current = null
    setLoadingEarlier(false)
    version.current = ''; through.current = ''
    setMessages([]); setBefore(''); stickToBottom.current = true
  }

  useEffect(() => {
    let cancelled = false
    apiFetch('GET', '/api/settings').then(settings => {
      if (!cancelled) setCanSend(settings.webMutations && !settings.readOnly)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [sessionId])

  useLayoutEffect(() => {
    if (active && !wasActive.current) stickToBottom.current = true
    wasActive.current = active
    const el = output.current
    if (!el || !active) return
    if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height
      prepend.current = null
    } else if (stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, sends, active])

  useEffect(() => () => earlierRequest.current?.abort(), [])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    let timer
    const readOutput = async () => {
      const query = new URLSearchParams({ history: '1' })
      if (through.current) query.set('since', through.current)
      if (version.current) query.set('if-version', version.current)
      const res = await fetch(path + '/output?' + query, { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
      if (res.status === 409) { resetHistory(); return }
      if (res.status !== 204) {
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error?.message || 'Unable to read conversation')
        if (controller.signal.aborted) return
        const initial = !through.current
        const fallback = !Array.isArray(data.messages)
        setLatestOnly(fallback)
        version.current = data.content_version || ''
        through.current = data.through_cursor || ''
        const rows = data.messages || (data.content ? [{ id: 'response', role: 'assistant', content: data.content }] : [])
        setMessages(old => fallback || initial ? rows : mergeMessages(old, [...rows, ...(data.updates || [])], data.removed))
        if (initial || fallback) setBefore(data.has_more ? data.before_cursor : '')
      }
      setLoading(false); setError('')
    }
    const readSends = async () => {
      if (remote) {
        for (const sendID of remoteSends.current) {
          const res = await fetch(path + '/send-status?send-id=' + encodeURIComponent(sendID), { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error?.message || 'Unable to read remote send status')
          if (controller.signal.aborted) return
          setSends(old => old.map(s => s.send_id === sendID ? { ...s, ...data } : s))
          if (data.settled || ['landed', 'failed'].includes(data.state)) remoteSends.current.delete(sendID)
        }
        setDeliveryError('')
        return
      }
      const query = sendVersion.current ? '?if-version=' + encodeURIComponent(sendVersion.current) : ''
      const res = await fetch(path + '/send-status' + query, { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
      if (res.status !== 204) {
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error?.message || 'Unable to read send status')
        if (controller.signal.aborted) return
        sendVersion.current = data.content_version || ''
        setSends(old => {
          const records = new Map(old.map(s => [s.send_id, s]))
          for (const s of data.sends || []) records.set(s.send_id, s)
          return [...records.values()]
        })
      }
      setDeliveryError('')
    }
    const poll = async () => {
      if (!document.hidden) {
        await Promise.all([
          readOutput().catch(e => { if (!controller.signal.aborted) { setError(e.message); setLoading(false) } }),
          readSends().catch(e => { if (!controller.signal.aborted) setDeliveryError(e.message) }),
        ])
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, remote ? 5000 : 2000)
    }
    poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [path, active, remote])

  const loadEarlier = async () => {
    if (!before || earlierRequest.current) return
    const controller = new AbortController()
    earlierRequest.current = controller
    setLoadingEarlier(true)
    try {
      const query = new URLSearchParams({ history: '1', before })
      const res = await fetch(path + '/output?' + query, { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
      if (res.status === 409) { resetHistory(); return }
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error?.message || 'Unable to load earlier messages')
      if (controller.signal.aborted) return
      const el = output.current
      prepend.current = { top: el.scrollTop, height: el.scrollHeight }
      stickToBottom.current = false
      setMessages(old => mergeMessages(data.messages || [], old))
      setBefore(data.has_more ? data.before_cursor : '')
      setError('')
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message)
    } finally {
      if (earlierRequest.current === controller) earlierRequest.current = null
      if (!controller.signal.aborted) setLoadingEarlier(false)
    }
  }

  const send = async () => {
    if (!enabled || !text.trim() || !canSend || inFlight.current || draftAction.current) return
    inFlight.current = true
    setSending(true); setStatus('Sending…')
    try {
      let result
      const body = remote ? { text } : { text, client_id: sendKeyFor(path, text) }
      if (mobileComposer && !remote) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
        let res
        try {
          res = await fetch(path + '/send', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal: controller.signal })
          result = await res.json()
        } catch (e) {
          throw controller.signal.aborted ? new Error('no response, sending again will not duplicate it') : e
        } finally { clearTimeout(timeout) }
        if (!res.ok) {
          const failure = new Error(result?.error?.message || 'Unable to send message')
          failure.code = result?.error?.code
          throw failure
        }
      } else result = await apiFetch('POST', path + '/send', body)
      if (!remote) clearSendKey(path)
      if (remote) remoteSends.current.add(result.send_id)
      setSends(old => [...old.filter(s => s.send_id !== result.send_id), { message: text, created_at: new Date().toISOString(), ...result }])
      setStatus(result.warning || '')
      setText('')
      onTextChange?.('')
    } catch (e) {
      if (mobileComposer && !remote && /FOREIGN_DRAFT|COMPOSER_BLOCKED|foreign|composer.*(draft|occupied|blocked)|desktop.*draft/i.test((e.code || '') + ' ' + e.message)) {
        setComposerRefresh(value => value + 1)
        setStatus('Review the unsent desktop draft above.')
      } else setStatus('Send failed: ' + e.message)
    } finally {
      inFlight.current = false; setSending(false)
    }
  }

  const dismiss = async send => {
    setSends(old => old.filter(s => s.send_id !== send.send_id))
    if (remote) { remoteSends.current.delete(send.send_id); return }
    try {
      await apiFetch('POST', path + '/send-status/dismiss', { send_id: send.send_id })
    } catch (e) { setDeliveryError('Dismiss failed: ' + e.message) }
  }

  // Edit puts the unsent text back in the composer to review and send again:
  // a not-confirmed send may still have reached the agent, so never resend it blindly.
  const editUnsent = send => {
    const old = currentText.current
    const next = old ? old + '\n\n' + send.message : send.message
    onTextChange?.(next); setText(next); setStatus('')
    dismiss(send)
    input.current?.focus()
  }

  const delivered = new Map(sends.filter(s => s.landed_row_id).map(s => [s.landed_row_id, s]))
  const seen = new Set(messages.map(m => m.id))
  const oldest = messages.find(m => m.timestamp)?.timestamp
  // A send whose watch ended may still land later; its row then shows it.
  const landedLate = s => dismissable(s) && messages.some(m => m.role === 'user' && m.timestamp && m.timestamp >= s.created_at &&
    (m.content || '').trim() === (s.message || '').trim())
  const pending = sends.filter(s => !seen.has(s.landed_row_id) && !landedLate(s) &&
    (s.state !== 'landed' || !oldest || s.created_at >= oldest))
  const rows = [...messages.filter(m => mobileComposer || m.tool?.kind !== 'thinking').map(m => ({ ...m, send: delivered.get(m.id) })),
    ...pending.map(s => ({ id: 'send:' + s.send_id, role: 'user', content: s.message, send: s }))]
  const groups = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last?.role === row.role) last.rows.push(row)
    else groups.push({ role: row.role, rows: [row] })
  }
  const sections = groups.map(group => ({ ...group, segments: segmentChatRows(group.rows) }))
  let latestToolGroup = ''
  for (const section of sections) {
    for (const segment of section.segments) if (segment.tools) latestToolGroup = segment.rows[0].id
  }

  return html`
    <div class="session-chat">
      <div ref=${output} class="session-chat-output" aria-label="Conversation" tabIndex="0"
        onScroll=${() => { const el = output.current; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        ${before && html`<button type="button" class="session-chat-earlier" disabled=${loadingEarlier} onClick=${loadEarlier}>${loadingEarlier ? 'Loading…' : 'Load earlier'}</button>`}
        ${remote && latestOnly && html`<p>Latest remote response only. Earlier history and Terminal are unavailable.</p>`}
        ${error && html`<p role="alert">${error}</p>`}
        ${sections.map(group => html`<section class=${'session-chat-message ' + group.role} key=${group.rows[0].id}>
          <h3>${group.role === 'user' ? 'You' : 'Assistant'}</h3>
          ${group.segments.map(segment => {
            const m = segment.rows[0]
            if (segment.tools && mobileComposer) return html`<${ToolStepGroup} key=${m.id} steps=${segment.rows} live=${sessionStatus === 'running' && latestToolGroup === m.id}/>`
            return html`<div key=${m.id} data-message-id=${m.id}>
              ${!segment.tools && m.content && (group.role === 'user' ? html`<p class="session-chat-user-text">${m.content}</p>` : renderMarkdown(m.content))}
              ${segment.tools && html`<p class="session-chat-tools">Tool activity omitted</p>`}
              ${m.send && html`<p class=${'session-chat-delivery ' + m.send.state} role="status">${deliveryLabel(m.send)}${
                m.id === 'send:' + m.send.send_id && dismissable(m.send) && canSend && html`
                  ${' · '}<button type="button" class="session-chat-link" aria-label="Edit unsent message" onClick=${() => editUnsent(m.send)}>Edit</button>
                  ${' · '}<button type="button" class="session-chat-link" aria-label="Dismiss unsent message" onClick=${() => dismiss(m.send)}>Dismiss</button>`}</p>`}
            </div>`
          })}
        </section>`)}
        ${!rows.length && html`<p>${loading ? 'Loading conversation…' : 'No messages yet.'}</p>`}
      </div>
      ${onOpenTerminal && !remote && html`<${InputPromptCard} key=${path} path=${path} active=${active} interactiveMenu=${interactiveMenu} enabled=${enabled} canAnswer=${canSend} onOpenTerminal=${onOpenTerminal}/>`}
      ${mobileComposer && !remote && html`<${PhoneComposerNotice} key=${path} path=${path} active=${active} enabled=${enabled} canTake=${canSend && !sending} refresh=${composerRefresh}
        onBusyChange=${busy => { draftAction.current = busy; setMovingDraft(busy) }}
        onMove=${draft => { const old = currentText.current; const next = old ? old + '\n\n' + draft : draft; onTextChange?.(next); setText(next); setStatus(''); input.current?.focus() }}/>`}
      <div class=${'session-chat-composer' + (mobileComposer ? ' phone-composer' : '')} data-expanded=${mobileComposer ? String(expanded) : undefined}
        onFocusCapture=${() => setFocused(true)} onBlurCapture=${e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false) }}>
        <textarea ref=${input} aria-label="Message" rows=${mobileComposer ? '1' : '3'} placeholder=${mobileComposer && canSend ? 'Message this session…' : canSend ? 'Message this session. Ctrl/Cmd+Enter to send.' : 'Sending is disabled in read-only mode or when web mutations are off.'}
          value=${text} disabled=${!enabled || !canSend || sending}
          onInput=${e => { setText(e.target.value); onTextChange?.(e.target.value) }}
          onKeyDown=${e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
              e.preventDefault()
              send()
            }
          }}/>
        <div class="session-chat-actions">
          ${bottomLeft}
          ${mobileComposer && html`<button type="button" class="phone-composer-dismiss" aria-label="Dismiss keyboard" onClick=${() => { document.activeElement?.blur(); setFocused(false) }}>Done</button>`}
          <span role="status">${status || deliveryError}</span>
          <button type="button" disabled=${!enabled || !canSend || !text.trim() || sending || movingDraft} onClick=${send} aria-label="Send">${mobileComposer ? html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>` : 'Send'}</button>
        </div>
      </div>
    </div>
  `
}
