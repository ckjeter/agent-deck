import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { html } from 'htm/preact'
import { render as preactRender } from 'preact'

const mounted = []
function render(vnode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  preactRender(vnode, container)
  mounted.push(container)
}
function unmount() {
  for (const c of mounted.splice(0)) { preactRender(null, c); c.remove() }
}
import { SessionChat } from '../../../internal/web/static/app/SessionChat.js'
import { TerminalPane } from '../../../internal/web/static/app/panes/TerminalPane.js'
import { renderMarkdown } from '../../../internal/web/static/app/miniMarkdown.js'
import { selectedIdSignal } from '../../../internal/web/static/app/state.js'
import { activeTabSignal } from '../../../internal/web/static/app/uiState.js'

beforeEach(() => {
  localStorage.removeItem('agentdeck.sessionView')
  selectedIdSignal.value = 'one'
  activeTabSignal.value = 'terminal'
  vi.stubGlobal('fetch', vi.fn(async (path, options) => {
    if (path === '/api/settings') return { ok: true, json: async () => ({ webMutations: true, readOnly: false }) }
    if (path.includes('/send-status')) return { ok: true, status: 200, json: async () => ({ sends: [], content_version: 'q0' }) }
    if (options?.method === 'POST') return { ok: true, json: async () => ({ send_id: 'send-1', state: 'queued' }) }
    return { ok: true, status: 200, json: async () => ({ content: '# Reply\nHello **world**', content_version: 'v1' }) }
  }))
})
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Session Chat', () => {
  it('renders safe markdown and preserves multiline native input', async () => {
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('world')
    const input = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.input(input, { target: { value: '你好\nsecond line' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true })
    expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0)
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await screen.findByText('queued · session is busy, will send when idle')
    const call = fetch.mock.calls.find(([, o]) => o?.method === 'POST')
    expect(call[0]).toBe('/api/sessions/one/send')
    expect(JSON.parse(call[1].body)).toEqual({ text: '你好\nsecond line', client_id: expect.any(String) })
    expect(input.value).toBe('')
  })

  it('disables composing in read-only mode', async () => {
    fetch.mockImplementation(async path => ({ ok: true, status: 200, json: async () => path === '/api/settings'
      ? { webMutations: true, readOnly: true } : { content: 'Read only' } }))
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('Read only')
    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('retains a draft on send failure', async () => {
    render(html`<${SessionChat} sessionId="one"/>`)
    const input = screen.getByRole('textbox')
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.input(input, { target: { value: 'keep this' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
    fetch.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: { message: 'session is not running' } }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Send failed: session is not running')
    expect(input.value).toBe('keep this')
  })

  it('polls with the previous version and keeps content on an empty response', async () => {
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('world')
    fetch.mockImplementation(async () => ({ ok: true, status: 204 }))
    await waitFor(() => expect(fetch.mock.calls.some(([p]) => p.includes('/output?history=1&if-version=v1'))).toBe(true), { timeout: 3500 })
    expect(screen.getByText('world')).toBeInTheDocument()
  })

  it('defaults to Chat on phone viewports and remembers an explicit choice', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    render(html`<${TerminalPane}/>`)
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(localStorage.getItem('agentdeck.sessionView')).toBe('chat')
    unmount()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    render(html`<${TerminalPane}/>`)
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders code fences as inert preformatted text', () => {
    render(html`<div>${renderMarkdown('~~~html\n<img src=x onerror=alert(1)>\n  indentation\n~~~\n[bad](javascript:alert(1))')}</div>`)
    expect(document.querySelector('pre code').textContent).toContain('\n  indentation')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
  })
})

describe('Conversation history and deliveries', () => {
  function response(data) { return { ok: true, status: 200, json: async () => data } }
  function installHistory(recent, status = []) {
    fetch.mockImplementation(async (path, options) => {
      if (path === '/api/settings') return response({ webMutations: true, readOnly: false })
      if (options?.method === 'POST') return response({ send_id: 'live-send', state: 'queued' })
      if (path.includes('/send-status')) return response({ sends: status, content_version: 'queue' })
      return response(recent)
    })
  }

  it('renders roles and loads earlier messages in order', async () => {
    installHistory({ messages: [{ id: 'u2', role: 'user', content: 'New question' }, { id: 'a2', role: 'assistant', content: 'New answer' }], has_more: true, before_cursor: 'older', through_cursor: 'tail', content_version: 'v2' })
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('New answer')
    expect(screen.getAllByRole('heading').map(el => el.textContent)).toEqual(['You', 'Assistant'])
    fetch.mockImplementationOnce(async () => response({ messages: [{ id: 'u1', role: 'user', content: 'Old question' }, { id: 'a1', role: 'assistant', content: 'Old answer' }], has_more: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    await screen.findByText('Old answer')
    expect([...document.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
  })

  it('updates queue states while the transcript is unchanged and deduplicates the landed message', async () => {
    let queue = { send_id: 'live-send', message: 'Waiting prompt', state: 'queued' }
    let landed = false
    fetch.mockImplementation(async path => {
      if (path === '/api/settings') return response({ webMutations: true, readOnly: false })
      if (path.includes('/send-status')) return response({ sends: [queue], content_version: queue.state })
      if (landed) return response({ messages: [{ id: 'native-user', role: 'user', content: 'Waiting prompt' }], through_cursor: 'new', content_version: 'v2' })
      if (path.includes('if-version')) return { ok: true, status: 204 }
      return response({ messages: [{ id: 'a1', role: 'assistant', content: 'Working answer' }], through_cursor: 'cursor', content_version: 'v1' })
    })
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('queued · session is busy, will send when idle')
    expect(screen.getByText('Waiting prompt')).toBeInTheDocument()
    queue = { ...queue, state: 'typing' }
    await screen.findByText('typing', {}, { timeout: 3500 })
    queue = { ...queue, state: 'submitted' }
    await screen.findByText('submitted', {}, { timeout: 3500 })
    landed = true
    queue = { ...queue, state: 'landed', landed_row_id: 'native-user' }
    await screen.findByText('landed', {}, { timeout: 3500 })
    expect(screen.getAllByText('Waiting prompt')).toHaveLength(1)
    queue = { ...queue, state: 'failed', reason: 'delivery failed' }
    await screen.findByText('failed · delivery failed', {}, { timeout: 3500 })
  }, 12000)

  it('follows new messages only while near the bottom and preserves the viewport when prepending', async () => {
    let page = { messages: [{ id: 'a1', role: 'assistant', content: 'Initial answer' }], has_more: true, before_cursor: 'older', through_cursor: 'c1', content_version: 'v1' }
    installHistory(page)
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('Initial answer')
    const el = screen.getByLabelText('Conversation')
    let height = 1000
    Object.defineProperties(el, { scrollHeight: { get: () => height + (el.textContent.includes('Earlier prompt') ? 300 : 0), configurable: true }, clientHeight: { value: 400, configurable: true } })
    el.scrollTop = 100
    fireEvent.scroll(el)
    page = { messages: [{ id: 'a2', role: 'assistant', content: 'Updated answer' }], through_cursor: 'c2', content_version: 'v2' }
    installHistory(page)
    await screen.findByText('Updated answer', {}, { timeout: 3500 })
    expect(el.scrollTop).toBe(100)
    el.scrollTop = 600
    fireEvent.scroll(el)
    height = 1200
    installHistory({ messages: [{ id: 'a3', role: 'assistant', content: 'Newest answer' }], through_cursor: 'c3', content_version: 'v3' })
    await screen.findByText('Newest answer', {}, { timeout: 3500 })
    expect(el.scrollTop).toBe(1200)
    el.scrollTop = 20
    fireEvent.scroll(el)
    fetch.mockImplementationOnce(async () => response({ messages: [{ id: 'old', role: 'user', content: 'Earlier prompt' }], has_more: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    await screen.findByText('Earlier prompt')
    expect(el.scrollTop).toBe(320)
  }, 10000)
  it('groups consecutive tool steps with live progress and collapsed reasoning', async () => {
    installHistory({ messages: [
      { id: 'a1', role: 'assistant', content: 'Working through the turn' },
      { id: 'think', role: 'assistant', tools: true, tool: { kind: 'thinking', title: 'Thinking', detail: 'Plan <img src=x onerror=alert(1)>' } },
      ...[1, 2, 3].map(n => ({ id: 'bash-' + n, role: 'assistant', tools: true, tool: { kind: 'bash', title: 'Run command ' + n, target: 'command-' + n, finished: n < 3 } })),
      { id: 'edit-1', role: 'assistant', tools: true, tool: { kind: 'edit', title: 'Edited app.css', target: 'app.css', added: 4, removed: 2, finished: true } },
      { id: 'edit-2', role: 'assistant', tools: true, tool: { kind: 'edit', title: 'Edited Chat.js', target: 'SessionChat.js', result: 'Added 1 line', finished: true } },
    ], through_cursor: 'tools-1', content_version: 'tools-v1' })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true} sessionStatus="running"/>`)
    const summary = await screen.findByRole('button', { name: /Ran 3 commands, edited 2 files, thinking/ })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('img', { name: 'Live tool activity' })).toBeInTheDocument()
    expect(summary).toHaveTextContent('Edited Chat.js')
    expect(screen.queryByText('command-1')).toBeNull()
    expect(screen.queryByText('Plan <img src=x onerror=alert(1)>')).toBeNull()

    fireEvent.click(summary)
    await waitFor(() => expect(summary).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByText('command-1')).toBeInTheDocument()
    expect(screen.getByText('+4 / -2')).toBeInTheDocument()
    expect(screen.getByText('Plan <img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Ran 3 commands/ })).toHaveLength(1)
  })

  it('keeps tool labels through result updates and follows new steps at the bottom', async () => {
    installHistory({ messages: [{ id: 'tool-1', role: 'assistant', tools: true, tool: { kind: 'bash', title: 'Run tests', target: 'go test ./...', finished: false } }], through_cursor: 'c1', content_version: 'v1' })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true} sessionStatus="running"/>`)
    const summary = await screen.findByRole('button', { name: /Ran 1 command/ })
    fireEvent.click(summary)
    await screen.findByText('go test ./...')
    const output = screen.getByLabelText('Conversation')
    let height = 1000
    Object.defineProperties(output, { scrollHeight: { get: () => height, configurable: true }, clientHeight: { value: 400, configurable: true } })
    output.scrollTop = 600
    fireEvent.scroll(output)
    height = 1200
    installHistory({
      messages: [{ id: 'tool-2', role: 'assistant', tools: true, tool: { kind: 'bash', title: 'Build app', target: 'go build ./...', finished: false } }],
      updates: [{ id: 'tool-1', role: 'assistant', tools: true, tool: { result: 'Exit code 0', finished: true } }],
      through_cursor: 'c2', content_version: 'v2',
    })
    await screen.findByRole('button', { name: /Ran 2 commands/ }, { timeout: 3500 })
    expect(summary).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('go test ./...')).toBeInTheDocument()
    expect(screen.getByText('Exit code 0')).toBeInTheDocument()
    expect(screen.getByText('go build ./...')).toBeInTheDocument()
    await waitFor(() => expect(output.scrollTop).toBe(1200))
  })

  it('keeps desktop tool placeholders and hides reasoning rows', async () => {
    installHistory({ messages: [
      { id: 'think', role: 'assistant', tools: true, tool: { kind: 'thinking', title: 'Thinking', detail: 'Existing reasoning' } },
      { id: 'answer', role: 'assistant', content: 'Desktop answer' },
      { id: 'tool', role: 'assistant', tools: true, tool: { kind: 'bash', title: 'Run tests' } },
    ] })
    render(html`<${SessionChat} sessionId="one"/>`)
    await screen.findByText('Desktop answer')
    expect(screen.getAllByText('Tool activity omitted')).toHaveLength(1)
    expect(screen.queryByText('Existing reasoning')).toBeNull()
    expect(document.querySelector('.session-tool-group')).toBeNull()
  })

  it('splits step groups around assistant text and escapes step fields', async () => {
    const untrusted = '<img src=x onerror=alert(1)>'
    installHistory({ messages: [
      { id: 'command', role: 'assistant', tools: true, tool: { kind: 'bash', title: untrusted, target: untrusted, result: untrusted } },
      { id: 'text', role: 'assistant', content: 'Now update the file' },
      { id: 'edit', role: 'assistant', tools: true, tool: { kind: 'edit', title: 'Edit file', target: 'app.js' } },
    ] })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true}/>`)
    const commands = await screen.findByRole('button', { name: 'Ran 1 command' })
    const edits = screen.getByRole('button', { name: 'Edited 1 file' })
    fireEvent.click(commands)
    await waitFor(() => expect(screen.getAllByText(untrusted)).toHaveLength(3))
    expect(edits).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('app.js')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
})


describe('Phone composer', () => {
  it('expands on focus, keeps a draft open, and collapses after an empty blur', async () => {
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true}/>`)
    const input = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(input).not.toBeDisabled())
    const composer = input.closest('.session-chat-composer')
    expect(composer).toHaveAttribute('data-expanded', 'false')
    fireEvent.focus(input)
    await waitFor(() => expect(composer).toHaveAttribute('data-expanded', 'true'))
    fireEvent.input(input, { target: { value: 'Draft 中文' } })
    fireEvent.blur(input)
    await waitFor(() => expect(composer).toHaveAttribute('data-expanded', 'true'))
    fireEvent.input(input, { target: { value: '' } })
    await waitFor(() => expect(composer).toHaveAttribute('data-expanded', 'false'))
  })

  it('restores an expanded draft and sends through the existing delivery path', async () => {
    const onTextChange = vi.fn()
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true} initialText="Saved draft" onTextChange=${onTextChange}/>`)
    const input = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(input).not.toBeDisabled())
    expect(input.closest('.session-chat-composer')).toHaveAttribute('data-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }))
    await waitFor(() => expect(input).toHaveValue(''))
    expect(onTextChange).toHaveBeenCalledWith('')
    expect(input.closest('.session-chat-composer')).toHaveAttribute('data-expanded', 'false')
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })
})

describe('Remote conversation history', () => {
  it('requests remote history and prepends older pages without latest-only copy', async () => {
    fetch.mockImplementation(async path => {
      if (path === '/api/settings') return { ok: true, json: async () => ({ webMutations: true }) }
      if (path.includes('before=older')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'old', role: 'user', content: 'Old remote prompt' }], has_more: false }) }
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'new', role: 'assistant', content: 'Recent remote reply' }], before_cursor: 'older', through_cursor: 'current', has_more: true }) }
    })
    render(html`<${SessionChat} sessionId="remote" endpoint="/api/remotes/mac/sessions/remote" remote=${true}/>`)
    await screen.findByText('Recent remote reply')
    expect(fetch.mock.calls.some(([p]) => p === '/api/remotes/mac/sessions/remote/output?history=1')).toBe(true)
    expect(screen.queryByText(/Latest remote response only/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    await screen.findByText('Old remote prompt')
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
    expect([...document.querySelectorAll('[data-message-id]')].map(n => n.dataset.messageId)).toEqual(['old', 'new'])
    expect(fetch.mock.calls.some(([p]) => p.includes('send-status'))).toBe(false)
  })

  it('uses latest-only presentation when a remote has no native transcript', async () => {
    render(html`<${SessionChat} sessionId="remote" endpoint="/api/remotes/mac/sessions/remote" remote=${true}/>`)
    await screen.findByText(/Latest remote response only/)
    expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
    expect(fetch.mock.calls.some(([p]) => p.includes('history=1'))).toBe(true)
  })
})

it('replaces remote history and clears paging when the transcript becomes unavailable', async () => {
  let fallback = false
  fetch.mockImplementation(async path => {
    if (path === '/api/settings') return { ok: true, json: async () => ({ webMutations: true }) }
    return { ok: true, status: 200, json: async () => fallback
      ? { content: 'Fallback answer', latest_only: true }
      : { messages: [{ id: 'history', role: 'assistant', content: 'Native answer' }], through_cursor: 'current', before_cursor: 'older', has_more: true } }
  })
  render(html`<${SessionChat} sessionId="remote" remote=${true}/>`)
  await screen.findByText('Native answer')
  expect(screen.getByRole('button', { name: 'Load earlier' })).toBeInTheDocument()
  fallback = true
  await screen.findByText('Fallback answer', {}, { timeout: 6500 })
  expect(screen.queryByText('Native answer')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Load earlier' })).toBeNull()
}, 8000)

describe('Phone send reliability', () => {
  const json = data => ({ ok: true, status: 200, json: async () => data })
  beforeEach(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('agentdeck.sendKey')) localStorage.removeItem(key) })

  async function typeAndSend(value) {
    const input = screen.getByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.input(input, { target: { value } })
    const button = screen.getByRole('button', { name: 'Send', exact: true })
    await waitFor(() => expect(button).not.toBeDisabled())
    fireEvent.click(button)
    return input
  }
  const posts = () => fetch.mock.calls.filter(([p, o]) => o?.method === 'POST' && p.endsWith('/send')).map(([, o]) => JSON.parse(o.body))

  it('retries a send whose response was lost with the same client id, also after a reload', async () => {
    let lose = true
    fetch.mockImplementation(async (path, options) => {
      if (path === '/api/settings') return json({ webMutations: true, readOnly: false })
      if (path.includes('/send-status')) return json({ sends: [], content_version: 'q0' })
      if (options?.method === 'POST') {
        if (lose) throw new TypeError('Load failed')
        return { ok: true, json: async () => ({ send_id: 'send-1', state: 'queued' }) }
      }
      return json({ messages: [], content_version: 'v1' })
    })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true}/>`)
    const input = await typeAndSend('only once please')
    await screen.findByText('Send failed: Load failed')
    expect(input.value).toBe('only once please')
    unmount()
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true} initialText="only once please"/>`)
    lose = false
    const again = await screen.findByRole('button', { name: 'Send', exact: true })
    await waitFor(() => expect(again).not.toBeDisabled())
    fireEvent.click(again)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' }).value).toBe(''))
    const [first, second] = posts()
    expect(first.client_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(second.client_id).toBe(first.client_id)
    await typeAndSend('only once please')
    await waitFor(() => expect(posts()).toHaveLength(3))
    expect(posts()[2].client_id).not.toBe(first.client_id)
  })

  it('gives up on a hung send request so it can be retried', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetch.mockImplementation(async (path, options) => {
      if (path === '/api/settings') return json({ webMutations: true, readOnly: false })
      if (path.includes('/send-status')) return json({ sends: [], content_version: 'q0' })
      if (options?.method === 'POST') return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      return json({ messages: [], content_version: 'v1' })
    })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true}/>`)
    await typeAndSend('hung request')
    await screen.findByText('Sending…')
    await vi.advanceTimersByTimeAsync(20000)
    await screen.findByText(/^Send failed: /)
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toBeDisabled()
  })

  it('labels a send whose delivery watch ended and lets the owner dismiss it', async () => {
    let sends = [{ send_id: 'stuck-1', message: 'never confirmed', state: 'typed', settled: true, created_at: '2026-11-11T20:49:30Z' }]
    fetch.mockImplementation(async (path, options) => {
      if (path === '/api/settings') return json({ webMutations: true, readOnly: false })
      if (path.includes('/send-status/dismiss')) { sends = []; return json({ send_id: 'stuck-1', dismissed: true }) }
      if (path.includes('/send-status')) return json({ sends, content_version: String(sends.length) })
      return json({ messages: [{ id: 'a1', role: 'assistant', content: 'Earlier answer', timestamp: '2026-11-11T20:00:00Z' }], content_version: 'v1' })
    })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true}/>`)
    await screen.findByText('never confirmed')
    expect(screen.queryByText('typed · submission unconfirmed')).toBeNull()
    expect(document.querySelector('.session-chat-delivery').textContent.replace(/\s+/g, ' ').trim()).toBe('not confirmed · Edit · Dismiss')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss unsent message' }))
    await waitFor(() => expect(screen.queryByText('never confirmed')).toBeNull())
    const call = fetch.mock.calls.find(([p]) => p.includes('/send-status/dismiss'))
    expect(call[0]).toBe('/api/sessions/one/send-status/dismiss')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ send_id: 'stuck-1' })
  })

  it('moves an unconfirmed send back into the composer for editing', async () => {
    let sends = [{ send_id: 'stuck-2', message: 'fix the build', state: 'typed', settled: true, created_at: '2026-11-11T20:49:30Z' }]
    fetch.mockImplementation(async path => {
      if (path === '/api/settings') return json({ webMutations: true, readOnly: false })
      if (path.includes('/send-status/dismiss')) { sends = []; return json({ send_id: 'stuck-2', dismissed: true }) }
      if (path.includes('/send-status')) return json({ sends, content_version: String(sends.length) })
      return json({ messages: [{ id: 'a1', role: 'assistant', content: 'Earlier answer', timestamp: '2026-11-11T20:00:00Z' }], content_version: 'v1' })
    })
    const onTextChange = vi.fn()
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true} initialText="also" onTextChange=${onTextChange}/>`)
    await screen.findByText('fix the build')
    fireEvent.click(screen.getByRole('button', { name: 'Edit unsent message' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' }).value).toBe('also\n\nfix the build'))
    expect(onTextChange).toHaveBeenLastCalledWith('also\n\nfix the build')
    await waitFor(() => expect(document.querySelector('.session-chat-delivery')).toBeNull())
    expect(fetch.mock.calls.some(([p]) => p.includes('/send-status/dismiss'))).toBe(true)
  })

  it('does not show a settled send a second time once its text lands late', async () => {
    fetch.mockImplementation(async path => {
      if (path === '/api/settings') return json({ webMutations: true, readOnly: false })
      if (path.includes('/send-status')) return json({ sends: [{ send_id: 'late-1', message: 'pi load more', state: 'typed', settled: true, created_at: '2026-11-11T14:51:10.386Z' }], content_version: 'q' })
      return json({ messages: [
        { id: 'a0', role: 'assistant', content: 'Before', timestamp: '2026-11-11T14:50:00Z' },
        { id: 'u1', role: 'user', content: 'pi load more', timestamp: '2026-11-11T14:53:50Z' },
      ], content_version: 'v1' })
    })
    render(html`<${SessionChat} sessionId="one" mobileComposer=${true}/>`)
    await screen.findByText('Before')
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getAllByText('pi load more')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Dismiss unsent message' })).toBeNull()
  })
})
