import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { render } from 'preact'
import { html } from 'htm/preact'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { PhoneSessionSheet, PhoneArchivedSheet, actionBlocker, createLongPress, UNDO_WINDOW_MS } from '../../../internal/web/static/app/PhoneSessionActions.js'
import { sessionsSignal, toastsSignal, archivedSessionsSignal } from '../../../internal/web/static/app/state.js'
import { addToast } from '../../../internal/web/static/app/toasts.js'

const writable = { webMutations: true, readOnly: false }
const target = { id: 'sess-1', title: 'Alpha', group: 'work', tool: 'claude', status: 'running' }
const reply = (status, body) => ({ ok: status < 400, status, statusText: 'x', json: async () => body })

describe('createLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const down = (h, x = 0, y = 0) => h.onPointerDown({ button: 0, clientX: x, clientY: y })

  it('fires after the delay and swallows exactly the click that follows', () => {
    const fired = vi.fn()
    const press = createLongPress(fired, { delay: 500 })
    const h = press.bind('a', 'A')
    down(h)
    vi.advanceTimersByTime(499)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledWith('A')
    h.onPointerUp()
    expect(press.consumeClick('a')).toBe(true)
    expect(press.consumeClick('a')).toBe(false)
  })

  it('a tap, a scroll and a browser-taken pointer never fire', () => {
    const fired = vi.fn()
    const press = createLongPress(fired, { delay: 500, slop: 10 })
    const h = press.bind('a', 'A')
    down(h); vi.advanceTimersByTime(100); h.onPointerUp()
    down(h); h.onPointerMove({ clientX: 0, clientY: 11 })
    down(h); h.onPointerCancel()
    vi.advanceTimersByTime(2000)
    expect(fired).not.toHaveBeenCalled()
    expect(press.consumeClick('a')).toBe(false)
  })

  it('small jitter inside the slop still fires', () => {
    const fired = vi.fn()
    const h = createLongPress(fired, { delay: 500, slop: 10 }).bind('a', 'A')
    down(h, 5, 5); h.onPointerMove({ clientX: 9, clientY: 9 })
    vi.advanceTimersByTime(500)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('contextmenu opens once during a held press, and the keyboard key never swallows a later click', () => {
    const fired = vi.fn()
    const press = createLongPress(fired, { delay: 500 })
    const h = press.bind('a', 'A')
    const menu = () => h.onContextMenu({ preventDefault() {} })
    down(h); vi.advanceTimersByTime(500); menu()
    expect(fired).toHaveBeenCalledTimes(1)
    down(h); menu(); vi.advanceTimersByTime(1000)
    expect(fired).toHaveBeenCalledTimes(2)
    expect(press.consumeClick('a')).toBe(true)
    menu()
    expect(fired).toHaveBeenCalledTimes(3)
    expect(press.consumeClick('a')).toBe(false)
  })

  it('a new press clears a stale swallow from a right click', () => {
    const press = createLongPress(() => {}, { delay: 500 })
    const h = press.bind('a', 'A')
    down(h); h.onContextMenu({ preventDefault() {} })
    down(h); h.onPointerUp()
    expect(press.consumeClick('a')).toBe(false)
  })
})

describe('actionBlocker', () => {
  it('names the reason for remote, read-only, disabled mutations and loading', () => {
    expect(actionBlocker(writable, 'mac')).toMatch(/on mac .*on that machine/)
    expect(actionBlocker({ webMutations: true, readOnly: true })).toMatch(/read-only/)
    expect(actionBlocker({ webMutations: false, readOnly: false })).toMatch(/Web changes are turned off/)
    expect(actionBlocker(null)).toMatch(/Loading/)
    expect(actionBlocker(writable)).toBe('')
  })
})

describe('toasts with an action', () => {
  beforeEach(() => { toastsSignal.value = []; vi.useFakeTimers() })
  afterEach(() => vi.useRealTimers())
  it('keeps the action and honours timeoutMs', () => {
    addToast('Deleted', 'info', { action: { label: 'Undo', onClick() {} }, timeoutMs: 20000 })
    expect(toastsSignal.value[0].action.label).toBe('Undo')
    vi.advanceTimersByTime(19999)
    expect(toastsSignal.value).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toastsSignal.value).toHaveLength(0)
  })
})

describe('PhoneSessionSheet', () => {
  let container
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    toastsSignal.value = []
    sessionsSignal.value = [
      { type: 'group', group: { name: 'work', path: 'work', sessionCount: 1 } },
      { type: 'group', group: { name: 'api', path: 'work/api', sessionCount: 0 } },
      { type: 'session', session: { id: 'sess-1', title: 'Alpha', groupPath: 'work', tool: 'claude', status: 'running' } },
    ]
  })
  afterEach(() => { render(null, container); container.remove(); vi.unstubAllGlobals() })

  it('lists the four actions with Delete last, enabled when writable', () => {
    render(html`<${PhoneSessionSheet} target=${target} settings=${writable} onClose=${() => {}}/>`, container)
    const dialog = screen.getByRole('dialog', { name: 'Actions for Alpha' })
    const names = [...dialog.querySelectorAll('.phone-action-list button')].map(b => b.textContent)
    expect(names).toEqual(['Rename', 'Move to group', 'Archive', 'Delete'])
    expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('disables every action with the reason for a remote session or read-only server', () => {
    render(html`<${PhoneSessionSheet} target=${{ ...target, remote: 'mac' }} settings=${writable} onClose=${() => {}}/>`, container)
    for (const name of ['Rename', 'Move to group', 'Archive', 'Delete']) expect(screen.getByRole('button', { name })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent('on mac')
    render(html`<${PhoneSessionSheet} target=${target} settings=${{ webMutations: true, readOnly: true }} onClose=${() => {}}/>`, container)
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent('read-only')
  })

  it('rename shows the API validation error inline and keeps the sheet open', async () => {
    const fetchMock = vi.fn(async () => reply(400, { error: { message: 'title cannot be empty' } }))
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn()
    render(html`<${PhoneSessionSheet} target=${target} settings=${writable} initialView="rename" onClose=${onClose}/>`, container)
    const input = screen.getByRole('textbox', { name: 'Session title' })
    expect(input).toHaveValue('Alpha')
    fireEvent.input(input, { target: { value: '  ' } })
    await waitFor(() => expect(input).toHaveValue('  '))
    fireEvent.submit(input.closest('form'))
    expect(await screen.findByRole('alert')).toHaveTextContent('title cannot be empty')
    expect(onClose).not.toHaveBeenCalled()
    expect(toastsSignal.value).toEqual([])
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: '  ' })
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH')
  })

  it('move lists the tree, marks the current group, and keeps a restart notice', async () => {
    const fetchMock = vi.fn(async () => reply(200, { sessionId: 'sess-1', groupPath: 'work/api', restartRequired: true }))
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn()
    render(html`<${PhoneSessionSheet} target=${target} settings=${writable} initialView="move" onClose=${() => {}} onDone=${onDone}/>`, container)
    expect(screen.getByRole('button', { name: /work Current/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /My Sessions/ })).toBeInTheDocument()
    const api = screen.getByRole('button', { name: /^api/ })
    expect(api.style.getPropertyValue('--group-depth')).toBe('1')
    fireEvent.click(api)
    expect(await screen.findByRole('status')).toHaveTextContent('Restart the session')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/sess-1/move')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ groupPath: 'work/api' })
    expect(onDone).toHaveBeenCalledWith('move')
  })

  it('archive says whether the process stops', () => {
    render(html`<${PhoneSessionSheet} target=${target} settings=${writable} initialView="archive" onClose=${() => {}}/>`, container)
    expect(screen.getByRole('dialog')).toHaveTextContent('Its process will be stopped.')
    render(html`<${PhoneSessionSheet} target=${{ ...target, status: 'stopped' }} settings=${writable} initialView="archive" onClose=${() => {}}/>`, container)
    expect(screen.getByRole('dialog')).toHaveTextContent('It is already stopped.')
  })

  it('delete names the session, says everywhere, and offers Undo that reports what came back', async () => {
    const fetchMock = vi.fn(async (path) => path.endsWith('/undelete')
      ? reply(200, { sessionId: 'sess-1' }) : reply(200, { deleted: 'sess-1' }))
    vi.stubGlobal('fetch', fetchMock)
    const onDone = vi.fn(), onClose = vi.fn()
    render(html`<${PhoneSessionSheet} target=${target} settings=${writable} onClose=${onClose} onDone=${onDone}/>`, container)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent('Alpha will be deleted everywhere'))
    expect(dialog).toHaveTextContent(`undo for ${UNDO_WINDOW_MS / 1000} seconds`)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('delete'))
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE')
    const toast = toastsSignal.value.find(t => t.message === 'Deleted “Alpha”')
    expect(toast.action.label).toBe('Undo')
    toast.action.onClick()
    await waitFor(() => expect(toastsSignal.value.some(t => t.message === 'Restored “Alpha”')).toBe(true))
    expect(fetchMock.mock.calls[1][0]).toBe('/api/sessions/undelete')
  })

  it('an expired undo says so instead of claiming a restore', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404, { error: { message: 'undo window expired' } })))
    const { undoDelete } = await import('../../../internal/web/static/app/PhoneSessionActions.js')
    await undoDelete(target)
    expect(toastsSignal.value.map(t => t.message)).toEqual(['Undo window has passed'])
  })
})

describe('PhoneArchivedSheet', () => {
  let container
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); toastsSignal.value = [] })
  afterEach(() => { render(null, container); container.remove(); vi.unstubAllGlobals() })

  it('restores an archived session and disables Restore when read-only', async () => {
    let archived = [{ id: 'old', title: 'Old work', groupPath: 'work', tool: 'codex', archivedAt: '2026-11-01T10:00:00Z' }]
    const fetchMock = vi.fn(async (path) => {
      if (path === '/api/sessions/archived') return reply(200, { sessions: archived })
      archived = []
      return reply(200, { sessionId: 'old' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onRestored = vi.fn()
    render(html`<${PhoneArchivedSheet} settings=${writable} onClose=${() => {}} onRestored=${onRestored}/>`, container)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Old work' }))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
    expect(fetchMock.mock.calls.some(([p, o]) => p === '/api/sessions/old/unarchive' && o.method === 'POST')).toBe(true)
    expect(await screen.findByText('No archived sessions.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/stays stopped/)

    archivedSessionsSignal.value = []
    archived = [{ id: 'old', title: 'Old work', groupPath: 'work' }]
    render(null, container)
    render(html`<${PhoneArchivedSheet} settings=${{ webMutations: false }} onClose=${() => {}}/>`, container)
    expect(await screen.findByRole('button', { name: 'Restore Old work' })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent('Web changes are turned off')
  })
})
