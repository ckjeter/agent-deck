import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { render } from 'preact'
import { html } from 'htm/preact'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { InputPromptCard } from '../../../internal/web/static/app/InputPromptCard.js'

const prompt = {
  supported: true, prompt_id: 'prompt-a', context: '$ curl https://example.com',
  options: [
    { number: 1, choice: 'once', scope: 'once', label: 'Yes, proceed' },
    { number: 2, choice: '2', scope: 'persistent', label: "Yes, and don't ask again for curl" },
    { number: 3, choice: 'deny', scope: 'deny', label: 'No' },
  ],
}
let container
function mount(props = {}) {
  render(html`<${InputPromptCard} path="/api/sessions/one" active=${true} interactiveMenu=${true} enabled=${true} canAnswer=${true} onOpenTerminal=${vi.fn()} ...${props}/>`, container)
}
const response = (data, ok = true) => ({ ok, json: async () => data })
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container)
  vi.stubGlobal('fetch', vi.fn(async () => response(prompt)))
})
afterEach(() => { render(null, container); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('inspects only an active selected interactive menu', async () => {
  mount({ interactiveMenu: false })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(fetch).not.toHaveBeenCalled()
  mount({ active: false })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(fetch).not.toHaveBeenCalled()
  mount()
  await screen.findByText(prompt.context)
  expect(screen.getByRole('button', { name: '1. Yes, proceed' })).toBeEnabled()
})

it('sends exactly once on double tap and keeps an unconfirmed prompt disabled', async () => {
  let finish
  fetch.mockImplementation(async (_path, options) => options?.method === 'POST'
    ? new Promise(resolve => { finish = resolve }) : response(prompt))
  mount()
  const once = await screen.findByRole('button', { name: '1. Yes, proceed' })
  fireEvent.click(once); fireEvent.click(once)
  await waitFor(() => expect(once).toBeDisabled())
  expect(screen.getByRole('button', { name: '3. No' })).toBeDisabled()
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
  expect(JSON.parse(fetch.mock.calls.find(([, o]) => o?.method === 'POST')[1].body)).toEqual({ prompt_id: 'prompt-a', choice: 'once' })
  finish(response({ error: { code: 'OUTCOME_UNCONFIRMED' }, key_sent: true }, false))
  await screen.findByText(/Choice sent, but clearing was not confirmed/)
  expect(once).toBeDisabled()
})

it('requires a second explicit confirmation for persistent scope', async () => {
  fetch.mockImplementation(async (_path, options) => options?.method === 'POST'
    ? response({ outcome: 'verified', key_sent: true, verified: true }) : response(prompt))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: "2. Yes, and don't ask again for curl" }))
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0)
  await screen.findByText(/persistent permission/)
  fireEvent.click(screen.getByRole('button', { name: 'Confirm this scope' }))
  await screen.findByText('Choice verified. The original prompt cleared.')
  expect(JSON.parse(fetch.mock.calls.find(([, o]) => o?.method === 'POST')[1].body)).toEqual({ prompt_id: 'prompt-a', choice: '2', confirm_scope: true })
})

it.each([
  ['PROMPT_CHANGED', /Prompt changed/],
  ['NO_PROMPT', /No active prompt/],
])('shows %s and inspects again without replaying', async (code, message) => {
  fetch.mockImplementation(async (_path, options) => options?.method === 'POST'
    ? response({ error: { code } }, false) : response(prompt))
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '3. No' }))
  await screen.findByText(message)
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
})

it('shows the next prompt without automatically answering it', async () => {
  let current = prompt
  fetch.mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') {
      current = { ...prompt, prompt_id: 'prompt-b', context: 'Another command' }
      return response({ outcome: 'next_prompt', verified: true, key_sent: true })
    }
    return response(current)
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '1. Yes, proceed' }))
  await screen.findByText('Another command')
  await screen.findByText(/Another prompt needs a decision/)
  expect(screen.getByRole('button', { name: '1. Yes, proceed' })).toBeEnabled()
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
})

it('disables choices in read-only or disconnected mode', async () => {
  mount({ canAnswer: false })
  expect(await screen.findByRole('button', { name: '1. Yes, proceed' })).toBeDisabled()
  mount({ enabled: false })
  expect(screen.getByRole('button', { name: '1. Yes, proceed' })).toBeDisabled()
})

it('offers a Terminal fallback for unsupported or undetected menus', async () => {
  const open = vi.fn()
  fetch.mockResolvedValue(response({ supported: false, reason: 'Codex only' }))
  mount({ onOpenTerminal: open })
  await screen.findByText('Codex only')
  fireEvent.click(screen.getByRole('link', { name: 'Open Terminal' }))
  expect(open).toHaveBeenCalledOnce()
})

it('never retries after a network error, even if the same prompt is inspected again', async () => {
  fetch.mockImplementation(async (_path, options) => {
    if (options?.method === 'POST') throw new Error('connection lost')
    return response(prompt)
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: '1. Yes, proceed' }))
  await screen.findByText(/Outcome unconfirmed/)
  expect(screen.getByRole('button', { name: '1. Yes, proceed' })).toBeDisabled()
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
})
