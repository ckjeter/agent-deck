import { describe, expect, it, vi } from 'vitest'
import { watchServiceWorkerUpdates, FRESH_WINDOW_MS } from '../../../internal/web/static/app/swUpdate.js'

const tick = () => new Promise(r => setTimeout(r, 0))

function setup({ visible = true, keys = ['agentdeck-shell-v30'] } = {}) {
  const container = new EventTarget()
  container.update = vi.fn(() => Promise.resolve())
  container.getRegistration = vi.fn(() => Promise.resolve({ update: container.update }))
  const doc = new EventTarget()
  doc.visibilityState = visible ? 'visible' : 'hidden'
  let t = 1000
  const state = { keys }
  const clock = { advance: ms => { t += ms } }
  const reload = vi.fn()
  watchServiceWorkerUpdates({ container, doc, reload, now: () => t, cacheKeys: () => Promise.resolve(state.keys) })
  const show = v => { doc.visibilityState = v ? 'visible' : 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) }
  const swap = async newKeys => { if (newKeys) state.keys = newKeys; container.dispatchEvent(new Event('controllerchange')); await tick(); await tick() }
  return { container, reload, clock, show, swap }
}

describe('watchServiceWorkerUpdates', () => {
  it('checks for a new worker when the app returns to the foreground', async () => {
    const { container, show } = setup({ visible: false })
    show(true)
    await tick()
    expect(container.update).toHaveBeenCalledTimes(1)
  })

  it('reloads at once when a new version lands right after launch', async () => {
    const { reload, clock, swap } = setup()
    clock.advance(FRESH_WINDOW_MS - 1)
    await swap(['agentdeck-shell-v31'])
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits for the next resume when a new version lands mid-use', async () => {
    const { reload, clock, swap, show } = setup()
    clock.advance(FRESH_WINDOW_MS + 1)
    await swap(['agentdeck-shell-v31'])
    expect(reload).not.toHaveBeenCalled()
    show(false)
    show(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores a controller change that brings no new version', async () => {
    const { reload, swap } = setup()
    await swap()
    await swap(['agentdeck-shell-v30', 'other-cache'])
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not reload on a first install', async () => {
    const { reload, swap } = setup({ keys: [] })
    await swap(['agentdeck-shell-v31'])
    expect(reload).not.toHaveBeenCalled()
  })
})
