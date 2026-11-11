import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { render } from 'preact'
import { html } from 'htm/preact'
import { SessionChat } from '../../../internal/web/static/app/SessionChat.js'

let container
afterEach(() => { if (container) { render(null, container); container.remove() }; vi.unstubAllGlobals() })

it('blocks sending during handoff and appends to the latest phone edits', async () => {
  let finishTake, moved = false
  const onTextChange = vi.fn()
  const response = data => ({ ok: true, status: 200, json: async () => data })
  vi.stubGlobal('fetch', vi.fn(async (path, options) => {
    if (path === '/api/settings') return response({ webMutations: true, readOnly: false })
    if (path.endsWith('/composer/take')) return new Promise(resolve => { finishTake = () => { moved = true; resolve(response({ draft: 'Desktop draft', verified: true })) } })
    if (path.endsWith('/composer')) return response({ visible: true, foreign: !moved, draft: 'Desktop draft', fingerprint: 'draft-1' })
    if (path.includes('/send-status')) return response({ sends: [], content_version: 'q1' })
    return response({ messages: [], content_version: 'v1' })
  }))
  container = document.createElement('div'); document.body.appendChild(container)
  render(html`<${SessionChat} sessionId="one" mobileComposer initialText="Phone thought" onTextChange=${onTextChange}/>`, container)
  const move = await screen.findByRole('button', { name: 'Move here' })
  await waitFor(() => expect(move).not.toBeDisabled())
  fireEvent.click(move)
  const send = screen.getByRole('button', { name: 'Send', exact: true })
  await waitFor(() => expect(send).toBeDisabled())
  const input = screen.getByRole('textbox', { name: 'Message', exact: true })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  expect(fetch.mock.calls.some(([path]) => path.endsWith('/send'))).toBe(false)
  fireEvent.input(input, { target: { value: 'Edited while moving' } })
  await waitFor(() => expect(onTextChange).toHaveBeenCalledWith('Edited while moving'))
  finishTake()
  await waitFor(() => expect(input).toHaveValue('Edited while moving\n\nDesktop draft'))
  expect(onTextChange).toHaveBeenLastCalledWith('Edited while moving\n\nDesktop draft')
  await waitFor(() => expect(send).not.toBeDisabled())
})
