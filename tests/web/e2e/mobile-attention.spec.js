import { test, expect } from '@playwright/test'

test.describe('phone attention states', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [{ id: 'answer', role: 'assistant', content: 'Phone conversation response' }], content_version: 'v1',
    } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [], content_version: 'q1' } }))
  })

  test('marks local rows and collapsed groups, filters attention, and follows menu SSE', async ({ page, request }) => {
    await request.post('/__fixture/session/sess-001/status?to=waiting&substate=interactive-menu')
    await request.post('/__fixture/session/sess-003/status?to=waiting')
    await request.post('/__fixture/session/sess-004/status?to=error')
    await page.goto('/')

    const decision = page.locator('.phone-session', { hasText: 'agent-deck' })
    const waiting = page.locator('.phone-session', { hasText: 'innotrade-api' })
    const error = page.locator('.phone-session', { hasText: 'scratch' })
    const running = page.locator('.phone-session', { hasText: 'frontend' })
    await expect(decision.locator('.phone-status')).toHaveText('Needs decision')
    await expect(waiting.locator('.phone-status')).toHaveText('Waiting for you')
    await expect(page.locator('[data-group-path="work"] .phone-group-attention')).toHaveText('2 need attention')
    await expect(page.locator('[data-group-path="work/innotrade"] .phone-group-attention')).toHaveText('1 need attention')
    await expect(page.locator('[data-group-path="personal"] > .phone-group-heading button')).toHaveAttribute('aria-expanded', 'false')
    await expect(error).toHaveCount(0)
    await expect(page.locator('[data-group-path="personal"] .phone-group-attention')).toHaveText('1 need attention')

    const filter = page.getByRole('button', { name: '3 need you', exact: true })
    await filter.click()
    await expect(filter).toHaveAttribute('aria-pressed', 'true')
    await expect(decision).toBeVisible()
    await expect(waiting).toBeVisible()
    await expect(error).toBeVisible()
    await expect(running).toHaveCount(0)
    await filter.click()
    await expect(filter).toHaveAttribute('aria-pressed', 'false')
    await expect(running).toBeVisible()

    await request.post('/__fixture/session/sess-001/status?to=running')
    await expect(decision.locator('.phone-status')).toHaveText('running', { timeout: 7000 })
    await expect(page.getByRole('button', { name: '2 need you', exact: true })).toBeVisible()
    await expect(page.locator('[data-group-path="work"] .phone-group-attention')).toHaveText('1 need attention')
  })

  test('keeps waiting quiet in Chat and shows only a minimal live error notice', async ({ page, request }) => {
    await request.post('/__fixture/session/sess-001/status?to=waiting')
    await page.goto('/s/sess-001')
    const composer = page.locator('.session-chat-composer')
    await expect(page.getByRole('status', { name: 'Session attention' })).toHaveCount(0)
    await expect(page.locator('.session-view-toggle')).toHaveCount(0)
    await expect(page.locator('.phone-context')).toHaveCount(0)
    await expect(page.getByRole('img', { name: 'Session status: Waiting for you' })).toBeVisible()
    const waitingComposer = await composer.boundingBox()
    await expect(page.locator('.phone-header button').first()).toHaveAttribute('aria-label', 'Back to sessions')

    await request.post('/__fixture/session/sess-001/status?to=error&substate=auth-401')
    await expect(page.locator('.phone-session-error')).toHaveText('Session error', { timeout: 7000 })
    await expect(page.locator('.phone-session-error')).toHaveCSS('white-space', 'nowrap')
    expect(await composer.boundingBox()).toEqual(waitingComposer)
    await request.post('/__fixture/session/sess-001/status?to=running')
    await expect(page.locator('.phone-session-error')).toHaveCount(0, { timeout: 7000 })
    expect(await composer.boundingBox()).toEqual(waitingComposer)
  })

  test('uses remote status and substate for counts, markers, filtering, and banners', async ({ page }) => {
    await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
      { name: 'mac', online: true, sessions: [
        { id: 'decision', title: 'Remote decision', tool: 'codex', group: 'Work', status: 'waiting', substate: 'interactive-menu' },
        { id: 'waiting', title: 'Remote waiting', tool: 'claude', group: 'Work', status: 'waiting' },
        { id: 'error', title: 'Remote error', tool: 'claude', group: 'Work', status: 'error' },
        { id: 'running', title: 'Remote running', tool: 'claude', group: 'Work', status: 'running' },
      ] },
    ] } }))
    await page.route('**/api/remotes/mac/sessions/decision/output?**', route => route.fulfill({ json: { content: 'Remote response', content_version: 'r1' } }))
    await page.goto('/')

    const remote = page.getByRole('region', { name: 'Remote mac', exact: true })
    await expect(remote.locator('.phone-group-attention').first()).toHaveText('3 need attention')
    await expect(remote.locator('[data-remote-group-path="Work"] .phone-group-attention')).toHaveText('3 need attention')
    await expect(remote.locator('.phone-session', { hasText: 'Remote decision' }).locator('.phone-status')).toHaveText('Needs decision')
    await expect(remote.locator('.phone-session', { hasText: 'Remote waiting' }).locator('.phone-status')).toHaveText('Waiting for you')
    await expect(remote.locator('.phone-session', { hasText: 'Remote error' }).locator('.phone-status')).toHaveText('Error')
    await page.getByRole('button', { name: '3 need you', exact: true }).click()
    await expect(remote.locator('.phone-session', { hasText: 'Remote running' })).toHaveCount(0)

    await remote.locator('.phone-session', { hasText: 'Remote decision' }).click()
    await expect(page.getByRole('status', { name: 'Session attention' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open Terminal', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Terminal/ })).toHaveCount(0)
    await expect(page.getByRole('img', { name: 'Session status: Needs decision' })).toBeVisible()
  })
})
