import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/preact'
import { render as preactRender } from 'preact'
import { html } from 'htm/preact'
import { PhoneComposerNotice } from '../../../internal/web/static/app/PhoneComposerNotice.js'

const draft = { visible: true, foreign: true, draft: 'Desktop 中文 draft', fingerprint: 'draft-1' }
let current, takes
let container
function render(vnode) {
  preactRender(vnode, container)
  return { rerender: vnode => preactRender(vnode, container) }
}
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container)
  current = draft; takes = []
  vi.stubGlobal('fetch', vi.fn(async (path, options) => {
    if (options?.method === 'POST') { takes.push(JSON.parse(options.body)); current = { foreign: false }; return { ok: true, json: async () => ({ draft: draft.draft, verified: true }) } }
    return { ok: true, json: async () => current }
  }))
})
afterEach(() => { preactRender(null, container); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('moves a fingerprint-bound draft without sending a message and ignores double taps', async () => {
  const onMove = vi.fn()
  render(html`<${PhoneComposerNotice} path="/api/sessions/one" active enabled canTake onMove=${onMove}/>`)
  expect(await screen.findByText('Desktop has an unsent draft: Desktop 中文 draft')).toBeInTheDocument()
  const move = screen.getByRole('button', { name: 'Move here' })
  fireEvent.click(move); fireEvent.click(move)
  await waitFor(() => expect(onMove).toHaveBeenCalledWith(draft.draft))
  expect(takes).toEqual([{ fingerprint: 'draft-1' }])
  expect(fetch.mock.calls.some(([path]) => path.endsWith('/send'))).toBe(false)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Move here' })).toBeNull())
})

it('requires confirmation before discard and leaves the phone text alone', async () => {
  const onMove = vi.fn()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(html`<${PhoneComposerNotice} path="/api/sessions/one" active enabled canTake onMove=${onMove}/>`)
  const discard = await screen.findByRole('button', { name: 'Discard' })
  fireEvent.click(discard)
  expect(takes).toEqual([])
  confirm.mockReturnValue(true)
  fireEvent.click(discard)
  await waitFor(() => expect(takes).toHaveLength(1))
  expect(onMove).not.toHaveBeenCalled()
})

it('refreshes a changed draft and keeps recovery text when clearing is unconfirmed', async () => {
  const onMove = vi.fn()
  const original = fetch.getMockImplementation()
  fetch.mockImplementation(async (path, options) => options?.method === 'POST'
    ? { ok: false, json: async () => ({ draft: draft.draft, verified: false, error: { code: 'CLEAR_UNCONFIRMED', message: 'Inspect Terminal before sending' } }) }
    : original(path, options))
  render(html`<${PhoneComposerNotice} path="/api/sessions/one" active enabled canTake onMove=${onMove}/>`)
  fireEvent.click(await screen.findByRole('button', { name: 'Move here' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Inspect Terminal before sending')
  expect(onMove).toHaveBeenCalledWith(draft.draft)
})

it('does not poll a closed session and disables handoff in read-only mode', async () => {
  const view = render(html`<${PhoneComposerNotice} path="/api/sessions/one" active=${false} enabled canTake=${false}/>`)
  expect(fetch).not.toHaveBeenCalled()
  view.rerender(html`<${PhoneComposerNotice} path="/api/sessions/one" active enabled canTake=${false}/>`)
  expect(await screen.findByRole('button', { name: 'Move here' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
})
