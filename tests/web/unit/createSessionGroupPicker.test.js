import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/preact'
import { html } from 'htm/preact'
import { render } from 'preact'
import { sessionsSignal, sessionCostsSignal, createSessionDialogSignal, mutationsEnabledSignal } from '../../../internal/web/static/app/state.js'
import { groupCreateDefaults } from '../../../internal/web/static/app/dataModel.js'
import { CreateSessionDialog } from '../../../internal/web/static/app/CreateSessionDialog.js'

const MENU = [
  { type: 'group', group: { name: 'work', path: 'work', defaultPath: '/srv/work' } },
  { type: 'group', group: { name: 'personal', path: 'personal', defaultPath: '/home/me' } },
]

let container
beforeEach(() => {
  sessionsSignal.value = MENU
  sessionCostsSignal.value = {}
  mutationsEnabledSignal.value = true
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => { render(null, container); container.remove(); createSessionDialogSignal.value = null; vi.unstubAllGlobals() })

describe('CreateSessionDialog group picker', () => {
  it('lets the user pick a group and reports the new session id', async () => {
    const posted = []
    vi.stubGlobal('fetch', vi.fn(async (path, options) => {
      if (options?.method === 'POST') { posted.push(JSON.parse(options.body)); return { ok: true, status: 201, json: async () => ({ sessionId: 'fresh' }) } }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    const onCreated = vi.fn()
    createSessionDialogSignal.value = groupCreateDefaults('')
    render(html`<${CreateSessionDialog} groupPicker=${true} onCreated=${onCreated}/>`, container)
    const picker = await screen.findByLabelText('GROUP')
    expect([...picker.options].map(o => o.value)).toEqual(['', 'work', 'personal'])
    fireEvent.change(picker, { target: { value: 'personal' } })
    await waitFor(() => expect(screen.getByDisplayValue('/home/me')).toBeTruthy())
    fireEvent.input(screen.getByPlaceholderText('session-name'), { target: { value: 'phone-made' } })
    await waitFor(() => expect(picker.closest('form').querySelector('button[type=submit]').disabled).toBe(false))
    fireEvent.submit(picker.closest('form'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('fresh', 'personal'))
    expect(posted[0]).toMatchObject({ title: 'phone-made', groupPath: 'personal', projectPath: '/home/me' })
  })

  it('keeps the read-only group on desktop', async () => {
    createSessionDialogSignal.value = groupCreateDefaults('work')
    render(html`<${CreateSessionDialog}/>`, container)
    expect((await screen.findByTestId('create-session-group')).textContent).toBe('work')
    expect(screen.queryByTestId('create-session-group-picker')).toBeNull()
  })
})
