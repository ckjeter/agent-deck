import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { render } from 'preact'
import { html } from 'htm/preact'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { PhoneShell } from '../../../internal/web/static/app/PhoneShell.js'
import { sessionsSignal, sessionsLoadedSignal, selectedIdSignal, selectedGroupSignal, selectSession,
  settingsSignal, connectionSignal, createSessionDialogSignal } from '../../../internal/web/static/app/state.js'
import { phoneViewportSignal, phoneDesktopSignal } from '../../../internal/web/static/app/phoneLayout.js'
import { groupExpandedSignal } from '../../../internal/web/static/app/uiState.js'

vi.mock('../../../internal/web/static/app/TerminalPanel.js', () => ({ TerminalPanel: ({ bottomLeft }) => html`<div>Raw terminal test surface<div class="phone-terminal-keys">${bottomLeft}</div></div>` }))
const group = (path, expanded = true) => ({ type: 'group', group: { name: path, path, expanded, sessionCount: 1 }, level: path.split('/').length - 1 })
const member = (id, groupPath, status = 'waiting') => ({ type: 'session', session: { id, title: id, groupPath, status, tool: 'claude', projectPath: '/tmp/repo', latestPrompt: 'Review the keyboard\nsecond line' } })
const openSearch = async () => {
  const toggle = screen.queryByRole('button', { name: 'Search', exact: true })
  if (toggle) fireEvent.click(toggle)
  return screen.findByRole('textbox', { name: 'Search sessions or groups' })
}
const pickFilter = async name => {
  fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
  fireEvent.click(await screen.findByRole('button', { name, exact: true }))
}
const filterState = async name => {
  fireEvent.click(screen.getByRole('button', { name: 'Filter sessions' }))
  const pressed = (await screen.findByRole('button', { name, exact: true })).getAttribute('aria-pressed')
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Filter sessions' })).toBeNull())
  return pressed
}
let container
beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div'); document.body.appendChild(container)
  phoneViewportSignal.value = true; phoneDesktopSignal.value = false
  selectedIdSignal.value = null; selectedGroupSignal.value = null
  settingsSignal.value = null; connectionSignal.value = 'connected'
  groupExpandedSignal.value = {}; createSessionDialogSignal.value = null
  sessionsSignal.value = [group('Work'), member('First session', 'Work'), group('Personal'), member('Second session', 'Personal', 'running')]
  sessionsLoadedSignal.value = true
  vi.stubGlobal('fetch', vi.fn(async (path, options) => ({ ok: true, status: 200, json: async () => {
    if (path === '/api/settings') return { profile: 'work', webMutations: true, readOnly: false }
    if (path === '/api/menu') return { items: sessionsSignal.value }
    if (options?.method === 'PATCH') return { expanded: JSON.parse(options.body).expanded }
    if (path.includes('/send-status')) return { sends: [] }
    return { messages: [{ id: 'answer', role: 'assistant', content: 'Session response' }], content_version: 'v1' }
  } })))
})
afterEach(() => { render(null, container); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('browses groups with prompt labels and fetches no transcript on the list', async () => {
  render(html`<${PhoneShell}/>`, container)
  await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).not.toBeDisabled())
  expect(screen.getAllByText('Prompt: Review the keyboard')).toHaveLength(2)
  expect(fetch.mock.calls.some(([path]) => path.includes('/output'))).toBe(false)
  fireEvent.input(await openSearch(), { target: { value: 'Second session' } })
  await waitFor(() => expect(screen.queryByRole('button', { name: /First session/ })).toBeNull())
  expect(screen.getByRole('button', { name: /Second session/ })).toBeInTheDocument()
})

it('restores drafts after a shell remount and removes deleted or expired entries', async () => {
  const key = (profile, id) => 'agentdeck.phoneDraft.v1:' + JSON.stringify([profile, id])
  const save = (profile, id, text, age = 0) => localStorage.setItem(key(profile, id), JSON.stringify({ text, updatedAt: Date.now() - age }))
  save('work', 'deleted', 'Remove')
  save('work', 'Second session', 'Expired', 7 * 86400000)
  save('personal', 'private', 'Other profile')
  render(html`<${PhoneShell}/>`, container)
  fireEvent.click(screen.getByRole('button', { name: /First session/ }))
  const input = await screen.findByRole('textbox', { name: 'Message', exact: true })
  await waitFor(() => expect(input).not.toBeDisabled())
  fireEvent.input(input, { target: { value: 'Saved across remount 中文\nNext line' } })
  render(null, container)
  render(html`<${PhoneShell}/>`, container)
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Saved across remount 中文\nNext line'))
  expect(localStorage.getItem(key('work', 'deleted'))).toBeNull()
  expect(localStorage.getItem(key('work', 'Second session'))).toBeNull()
  expect(localStorage.getItem(key('personal', 'private'))).toContain('Other profile')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send', exact: true })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }))
  await waitFor(() => expect(localStorage.getItem(key('work', 'First session'))).toBeNull())
})

it('persists collapse through the existing shared group PATCH', async () => {
  render(html`<${PhoneShell}/>`, container)
  await waitFor(() => expect(settingsSignal.value).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: /Work/ }))
  await waitFor(() => expect(fetch.mock.calls.some(([path, options]) => path === '/api/groups/Work' && options.method === 'PATCH' && JSON.parse(options.body).expanded === false)).toBe(true))
  expect(screen.queryByRole('button', { name: /First session/ })).toBeNull()
})

it('opens Chat by default and unmounts Terminal when Chat is selected from the session menu', async () => {
  localStorage.setItem('agentdeck.sessionView', 'terminal')
  render(html`<${PhoneShell}/>`, container)
  fireEvent.click(screen.getByRole('button', { name: /First session/ }))
  await screen.findByText('Session response')
  expect(screen.queryByText('Raw terminal test surface')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open Terminal', exact: true }))
  await screen.findByText('Raw terminal test surface')
  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Return to Chat', exact: true }))
  await waitFor(() => expect(screen.queryByText('Raw terminal test surface')).toBeNull())
  expect(screen.getByText('Session response')).toBeInTheDocument()
  selectSession('Second session')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Second session' })).toBeInTheDocument())
  expect(screen.queryByText('Raw terminal test surface')).toBeNull()
})

it('keeps list filters and scroll position on return and offers desktop layout', async () => {
  vi.spyOn(window.history, 'back').mockImplementation(() => selectSession(null))
  render(html`<${PhoneShell}/>`, container)
  const search = await openSearch()
  fireEvent.input(search, { target: { value: 'First' } })
  await waitFor(() => expect(screen.queryByRole('button', { name: /Second session/ })).toBeNull())
  container.querySelector('.phone-list').scrollTop = 160
  fireEvent.click(screen.getByRole('button', { name: /First session/ }))
  await screen.findByText('Session response')
  fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
  await waitFor(() => expect(search).toBeVisible())
  expect(search.value).toBe('First')
  expect(container.querySelector('.phone-list').scrollTop).toBe(160)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(await screen.findByRole('button', { name: 'More', exact: true }))
  await screen.findByRole('dialog', { name: 'More' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
  fireEvent.click(screen.getByRole('button', { name: 'Use desktop layout' }))
  expect(phoneDesktopSignal.value).toBe(true)
})

it('retains the native draft across Terminal mode and session navigation', async () => {
  render(html`<${PhoneShell}/>`, container)
  fireEvent.click(screen.getByRole('button', { name: /First session/ }))
  const input = await screen.findByRole('textbox', { name: 'Message', exact: true })
  await waitFor(() => expect(input).not.toBeDisabled())
  fireEvent.input(input, { target: { value: 'Keep this draft 你好' } })
  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open Terminal', exact: true }))
  await screen.findByText('Raw terminal test surface')
  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Return to Chat', exact: true }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message', exact: true }).value).toBe('Keep this draft 你好'))
  selectSession('Second session')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Second session' })).toBeInTheDocument())
  selectSession('First session')
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message', exact: true }).value).toBe('Keep this draft 你好'))
})

it('omits the server zero-time value instead of showing a year-one opened date', async () => {
  sessionsSignal.value = [group('Work'), { ...member('New session', 'Work'), session: { ...member('New session', 'Work').session, lastAccessedAt: '0001-01-01T00:00:00Z' } }]
  render(html`<${PhoneShell}/>`, container)
  expect(screen.getByRole('button', { name: /New session.*Prompt/ }).textContent).not.toContain('Opened')
})

it('lists remote sections and opens latest-only Chat without Terminal', async () => {
  const original = fetch.getMockImplementation()
  fetch.mockImplementation(async (path, options) => {
    if (path === '/api/remotes') return { ok: true, json: async () => ({ remotes: [
      { name: 'oracle', online: true, sessions: [{ id: 'remote-1', title: 'Remote project', status: 'waiting', tool: 'codex', group: 'Work' }] },
      { name: 'offline', online: false, stale: true, sessions: [] },
    ] }) }
    if (path.includes('/api/remotes/oracle/sessions/remote-1/output')) return { ok: true, status: 200, json: async () => ({ content: 'Remote reply', content_version: 'remote-v1' }) }
    return original(path, options)
  })
  render(html`<${PhoneShell}/>`, container)
  fireEvent.click(await screen.findByRole('button', { name: /Remote project/ }))
  await screen.findByText('Remote reply')
  expect(screen.queryByRole('button', { name: /Terminal/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  expect(await screen.findByRole('dialog', { name: 'Session menu' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open Terminal' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.getByText(/Latest remote response only/)).toBeInTheDocument()
  expect(fetch.mock.calls.some(([path]) => path.includes('/api/remotes/oracle/sessions/remote-1/output?') && path.includes('history=1'))).toBe(true)
})

it('nests remote groups, remembers collapse per remote and path, and searches group paths', async () => {
  const original = fetch.getMockImplementation()
  fetch.mockImplementation(async (path, options) => path === '/api/remotes' ? { ok: true, json: async () => ({ remotes: [
    { name: 'mac', online: true, sessions: [
      { id: 'one', title: 'One', group: 'agent-deck/phone', status: 'running' },
      { id: 'two', title: 'Two', group: 'agent-deck', status: 'waiting' },
      { id: 'root', title: 'Root remote', group: '', status: 'running' },
    ] },
  ] }) } : original(path, options))
  render(html`<${PhoneShell}/>`, container)
  const remote = await screen.findByRole('region', { name: 'Remote mac' })
  const parent = await screen.findByRole('button', { name: /agent-deck 2/ })
  expect(remote.querySelector('[data-remote-group-path="agent-deck/phone"]')).toBeTruthy()
  expect(screen.getByRole('button', { name: /Root remote/ })).toBeInTheDocument()
  fireEvent.click(parent)
  await waitFor(() => expect(parent).toHaveAttribute('aria-expanded', 'false'))
  expect(screen.queryByRole('button', { name: /One/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Two/ })).toBeNull()
  expect(localStorage.getItem('agentdeck.phone.remoteGroup.mac/agent-deck')).toBe('false')
  render(null, container)
  render(html`<${PhoneShell}/>`, container)
  expect(await screen.findByRole('button', { name: /agent-deck 2/ })).toHaveAttribute('aria-expanded', 'false')
  fireEvent.input(await openSearch(), { target: { value: 'phone' } })
  await waitFor(() => expect(screen.getByRole('button', { name: /One/ })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /Two/ })).toBeNull()
})

it('marks attention states, counts them in collapsed groups, and toggles the attention filter', async () => {
  const withStatus = (id, groupPath, status, substate = '') => ({
    ...member(id, groupPath, status),
    session: { ...member(id, groupPath, status).session, substate },
  })
  sessionsSignal.value = [
    group('Work'), withStatus('Decision session', 'Work', 'waiting', 'interactive-menu'),
    withStatus('Running session', 'Work', 'running'),
    group('Personal'), withStatus('Waiting session', 'Personal', 'waiting'),
    withStatus('Error session', 'Personal', 'error'),
  ]
  render(html`<${PhoneShell}/>`, container)

  expect(screen.getByRole('button', { name: '3 need you' })).toHaveAttribute('aria-pressed', 'false')
  expect(container.querySelector('[data-group-path="Work"] .phone-group-attention')).toHaveTextContent('1 need attention')
  expect(container.querySelector('[data-group-path="Personal"] .phone-group-attention')).toHaveTextContent('2 need attention')
  expect(screen.getByRole('button', { name: /Decision session/ }).querySelector('.phone-status')).toHaveTextContent('Needs decision')
  expect(screen.getByRole('button', { name: /Waiting session/ }).querySelector('.phone-status')).toHaveTextContent('Waiting for you')
  expect(screen.getByRole('button', { name: /Error session/ }).querySelector('.phone-status')).toHaveTextContent('Error')
  expect(screen.getByRole('button', { name: /Running session/ }).querySelector('.phone-status')).toHaveTextContent('running')

  fireEvent.click(screen.getByRole('button', { name: /Personal/ }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /Waiting session/ })).toBeNull())
  expect(container.querySelector('[data-group-path="Personal"] .phone-group-attention')).toHaveTextContent('2 need attention')

  const filter = screen.getByRole('button', { name: '3 need you' })
  fireEvent.click(filter)
  await waitFor(() => expect(filter).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.getByRole('button', { name: /Decision session/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Waiting session/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Error session/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Running session/ })).toBeNull()
  fireEvent.click(filter)
  await waitFor(() => expect(filter).toHaveAttribute('aria-pressed', 'false'))
  expect(screen.getByRole('button', { name: /Running session/ })).toBeInTheDocument()
})

it('counts remote decisions and errors and marks their last-known status without hiding urgency', async () => {
  sessionsSignal.value = [group('Work'), member('Local idle', 'Work', 'idle')]
  const original = fetch.getMockImplementation()
  fetch.mockImplementation(async (path, options) => path === '/api/remotes' ? { ok: true, json: async () => ({ remotes: [
    { name: 'mac', online: false, stale: true, sessions: [
      { id: 'decision', title: 'Remote decision', group: 'agent-deck/phone', status: 'waiting', substate: 'interactive-menu' },
      { id: 'error', title: 'Remote error', group: 'agent-deck', status: 'error', substate_detail: 'Authentication failed' },
      { id: 'running', title: 'Remote running', group: 'agent-deck', status: 'running' },
    ] },
  ] }) } : original(path, options))
  render(html`<${PhoneShell}/>`, container)

  expect(await screen.findByRole('button', { name: '2 need you' })).toBeInTheDocument()
  const remote = await screen.findByRole('region', { name: 'Remote mac' })
  expect(remote.querySelector('[data-remote-group-path="agent-deck"] .phone-group-attention')).toHaveTextContent('2 need attention')
  expect(screen.getByRole('button', { name: /Remote decision/ }).querySelector('.phone-status')).toHaveTextContent('Needs decision')
  expect(screen.getByRole('button', { name: /Remote error/ }).querySelector('.phone-status')).toHaveTextContent('Error')
  expect(screen.getByRole('button', { name: /Remote decision/ })).toHaveTextContent('Last known status')
})

it('omits waiting chrome and shows only a one-line inline session error', async () => {
  render(html`<${PhoneShell}/>`, container)
  fireEvent.click(screen.getByRole('button', { name: /First session/ }))
  await screen.findByText('Session response')
  expect(screen.queryByRole('status', { name: 'Session attention' })).toBeNull()
  expect(container.querySelector('.session-view-toggle')).toBeNull()
  expect(container.querySelector('.phone-context')).toBeNull()
  expect(screen.getByRole('img', { name: 'Session status: Waiting for you' })).toBeInTheDocument()

  sessionsSignal.value = [group('Work'), {
    ...member('First session', 'Work', 'error'),
    session: { ...member('First session', 'Work', 'error').session, substateDetail: 'Authentication failed' },
  }, group('Personal'), member('Second session', 'Personal', 'running')]
  expect(await screen.findByRole('alert')).toHaveTextContent('Session error · Authentication failed')
  expect(container.querySelectorAll('.phone-session-error')).toHaveLength(1)

  sessionsSignal.value = [group('Work'), member('First session', 'Work', 'running'), group('Personal'), member('Second session', 'Personal', 'running')]
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('textbox', { name: 'Message', exact: true })).toBeInTheDocument()
})

it('keeps Back at the top-left in both Chat and Terminal', async () => {
  render(html`<${PhoneShell}/>`, container)
  fireEvent.click(screen.getByRole('button', { name: /First session/ }))
  await screen.findByRole('textbox', { name: 'Message', exact: true })
  const back = screen.getByRole('button', { name: 'Back to sessions' })
  expect(container.querySelector('.phone-header').firstElementChild).toBe(back)
  expect(container.querySelector('.session-chat-actions').contains(back)).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Open Terminal', exact: true }))
  await screen.findByText('Raw terminal test surface')
  expect(container.querySelector('.phone-header').firstElementChild).toBe(screen.getByRole('button', { name: 'Back to sessions' }))
  expect(container.querySelector('.phone-terminal-keys').querySelector('button')).toBeNull()
})


it('filters Running locally and remotely, hides unrelated groups, and resets other filters', async () => {
  const original = fetch.getMockImplementation()
  fetch.mockImplementation(async (path, options) => path === '/api/remotes' ? { ok: true, json: async () => ({ remotes: [
    { name: 'mac', online: true, sessions: [
      { id: 'r1', title: 'Remote active', group: 'Work', status: 'running' },
      { id: 'r2', title: 'Remote waiting', group: 'Waiting', status: 'waiting' },
      { id: 'r3', title: 'Archived active', group: 'Archive', status: 'running', archived: true },
    ] },
  ] }) } : original(path, options))
  render(html`<${PhoneShell}/>`, container)
  await screen.findByRole('button', { name: /Remote active/ })
  await pickFilter('Waiting for input')
  await pickFilter('Running')
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Filter sessions' })).toBeNull())
  expect(screen.getByRole('button', { name: 'Filter sessions' })).toHaveAttribute('data-active', 'true')
  expect(await filterState('Running')).toBe('true')
  expect(await filterState('Waiting for input')).toBe('false')
  expect(await filterState('All')).toBe('false')
  expect(screen.queryByRole('button', { name: /First session/ })).toBeNull()
  expect(screen.getByRole('button', { name: /Second session/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Remote waiting/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Archived active/ })).toBeNull()
  expect(container.querySelector('[data-group-path="Work"]')).toBeNull()
  expect(container.querySelector('[data-remote-group-path="Waiting"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '2 need you' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '2 need you' })).toHaveAttribute('aria-pressed', 'true'))
  expect(await filterState('Running')).toBe('false')
  expect(screen.queryByRole('button', { name: /Remote active/ })).toBeNull()
  await pickFilter('Running')
  fireEvent.input(await openSearch(), { target: { value: 'missing' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Clear search' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Filter sessions' })).not.toHaveAttribute('data-active', 'true'))
  expect(await filterState('All')).toBe('true')
  expect(screen.getByRole('button', { name: /First session/ })).toBeInTheDocument()
})

it('folds search into the header: autofocus, clear text, Escape and Cancel close and clear', async () => {
  render(html`<${PhoneShell}/>`, container)
  expect(screen.queryByRole('textbox', { name: 'Search sessions or groups' })).toBeNull()
  expect(container.querySelector('.phone-sessions .phone-header h1')).toHaveTextContent('Sessions')
  fireEvent.click(screen.getByRole('button', { name: 'Search', exact: true }))
  const input = await screen.findByRole('textbox', { name: 'Search sessions or groups' })
  await waitFor(() => expect(input).toHaveFocus())
  expect(container.querySelector('.phone-sessions .phone-header h1')).toBeNull()
  fireEvent.input(input, { target: { value: 'Second session' } })
  await waitFor(() => expect(screen.queryByRole('button', { name: /First session/ })).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Clear search text' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /First session/ })).toBeInTheDocument())
  fireEvent.input(input, { target: { value: 'Second session' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Search sessions or groups' })).toBeNull())
  expect(screen.getByRole('button', { name: /First session/ })).toBeInTheDocument()
  fireEvent.input(await openSearch(), { target: { value: 'Second session' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /First session/ })).toBeInTheDocument())
  expect(await openSearch()).toHaveValue('')
})

it('puts New session, Refresh, profile, and connection state in the header and More, not a context line', async () => {
  render(html`<${PhoneShell}/>`, container)
  const create = screen.getByRole('button', { name: 'New session', exact: true })
  expect(container.querySelector('.phone-sessions .phone-header').contains(create)).toBe(true)
  await waitFor(() => expect(create).not.toBeDisabled())
  fireEvent.click(create)
  expect(createSessionDialogSignal.value).toBeTruthy()
  createSessionDialogSignal.value = null
  expect(container.querySelector('.phone-context')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  connectionSignal.value = 'disconnected'
  expect(await screen.findByRole('status', {}, { timeout: 3000 })).toHaveTextContent('Reconnecting')
  connectionSignal.value = 'connected'
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'More', exact: true }))
  const sheet = await screen.findByRole('dialog', { name: 'More' })
  expect(sheet).toHaveTextContent('Profile: work')
  const before = fetch.mock.calls.filter(([path]) => path === '/api/menu').length
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))
  await waitFor(() => expect(fetch.mock.calls.filter(([path]) => path === '/api/menu').length).toBe(before + 1))
})

it('keeps New session disabled when mutations are off', async () => {
  fetch.mockImplementation(async path => ({ ok: true, status: 200, json: async () => path === '/api/settings'
    ? { profile: 'work', webMutations: false, readOnly: true } : path === '/api/remotes' ? { remotes: [] } : { items: sessionsSignal.value } }))
  render(html`<${PhoneShell}/>`, container)
  await waitFor(() => expect(settingsSignal.value).not.toBeNull())
  expect(screen.getByRole('button', { name: 'New session', exact: true })).toBeDisabled()
})
