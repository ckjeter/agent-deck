import { test, expect } from '@playwright/test'

test.describe('phone send reliability', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await request.post('/__fixture/session/sess-001/status?to=waiting')
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [{ id: 'assistant-1', role: 'assistant', content: 'Ready.', timestamp: '2026-11-11T20:00:00Z' }], content_version: 'v1',
    } }))
    await page.setViewportSize({ width: 390, height: 844 })
  })

  test('a send whose response is lost is retried with the same client id after a reload', async ({ page }) => {
    const queued = new Map()
    const bodies = []
    let loseNext = true
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: {
      sends: [...queued.values()], content_version: String(queued.size),
    } }))
    await page.route(/\/api\/sessions\/[^/]+\/send$/, async route => {
      const body = route.request().postDataJSON()
      bodies.push(body)
      const key = body.client_id || 'none-' + bodies.length
      if (!queued.has(key)) queued.set(key, { send_id: 'send-' + (queued.size + 1), message: body.text, state: 'queued', created_at: new Date().toISOString() })
      if (loseNext) { loseNext = false; return route.abort('connectionreset') }
      return route.fulfill({ status: 202, json: { send_id: queued.get(key).send_id, state: 'queued' } })
    })
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message' })
    await input.fill('deploy once')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText(/^Send failed:/)).toBeVisible()
    await page.reload()
    await expect(input).toHaveValue('deploy once')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(input).toHaveValue('')
    expect(bodies).toHaveLength(2)
    expect(bodies[1].client_id).toBeTruthy()
    expect(bodies[1].client_id).toBe(bodies[0].client_id)
    expect(queued.size).toBe(1)
    await expect(page.locator('.session-chat-user-text', { hasText: 'deploy once' })).toHaveCount(1)
  })

  test('an unconfirmed send can be dismissed from the chat', async ({ page }) => {
    let sends = [{ send_id: '01M765YX6GEX0HA1CVAYPK6CJQ', message: 'never confirmed', state: 'typed', settled: true,
      reason: 'outcome unknown (send_failed: tmux send-keys exceeded 3s deadline)', created_at: '2026-11-11T20:49:30Z' }]
    let dismissed = null
    await page.route(/\/api\/sessions\/[^/]+\/send-status\/dismiss/, route => {
      dismissed = route.request().postDataJSON()
      sends = []
      return route.fulfill({ json: { send_id: dismissed.send_id, dismissed: true } })
    })
    await page.route(/\/api\/sessions\/[^/]+\/send-status(\?|$)/, route => route.fulfill({ json: { sends, content_version: String(sends.length) } }))
    await page.goto('/s/sess-001')
    await expect(page.getByText('never confirmed')).toBeVisible()
    await expect(page.getByText('not confirmed · the agent may not have received this')).toBeVisible()
    const dismiss = page.getByRole('button', { name: 'Dismiss unsent message' })
    const box = await dismiss.boundingBox()
    expect(box.height).toBeGreaterThanOrEqual(32)
    await dismiss.click()
    await expect(page.getByText('never confirmed')).toHaveCount(0)
    expect(dismissed).toEqual({ send_id: '01M765YX6GEX0HA1CVAYPK6CJQ' })
    await page.reload()
    await expect(page.getByText('Ready.')).toBeVisible()
    await expect(page.getByText('never confirmed')).toHaveCount(0)
  })
})
