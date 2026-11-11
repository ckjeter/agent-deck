import { test, expect } from '@playwright/test'

const prompt = {
  supported: true, tool: 'codex', kind: 'approval', prompt_id: 'prompt-a',
  context: 'Would you like to run the following command?\n$ curl https://example.com',
  options: [
    { number: 1, choice: 'once', label: 'Yes, proceed', scope: 'once' },
    { number: 2, choice: '2', label: "Yes, and don't ask again for curl", scope: 'persistent' },
    { number: 3, choice: 'deny', label: 'No', scope: 'deny' },
  ],
}

test.describe('phone Chat prompt decisions', () => {
  test.skip(({ viewport }) => viewport.width > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await request.post('/__fixture/session/sess-001/substate?to=interactive-menu')
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [{ id: 'a', role: 'assistant', content: 'Waiting for your decision' }], content_version: 'v1',
    } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [] } }))
    await page.route('**/api/sessions/sess-001/input-prompt', route => route.fulfill({ json: prompt }))
  })

  test('SSE menu opens the card, sends once, and preserves composer and header Back', async ({ page }) => {
    const sockets = [], choices = []
    page.on('websocket', ws => sockets.push(ws.url()))
    await page.route('**/input-prompt/choice', async route => {
      choices.push(route.request().postDataJSON())
      await new Promise(resolve => setTimeout(resolve, 250))
      await route.fulfill({ json: { outcome: 'verified', key_sent: true, verified: true } })
    })
    await page.goto('/s/sess-001')
    const card = page.getByRole('region', { name: 'Agent input prompt' })
    const once = card.getByRole('button', { name: '1. Yes, proceed' })
    await expect(once).toBeEnabled()
    await once.evaluate(button => { button.click(); button.click() })
    await expect(card.getByRole('button', { name: '3. No' })).toBeDisabled()
    await expect(card.getByText('Choice verified. The original prompt cleared.')).toBeVisible()
    expect(choices).toEqual([{ prompt_id: 'prompt-a', choice: 'once' }])
    expect(sockets).toEqual([])
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
    const back = page.getByRole('button', { name: 'Back to sessions' })
    const bounds = await back.boundingBox()
    expect(bounds.x).toBeLessThan(30)
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    const cardBounds = await card.boundingBox()
    const composerBounds = await page.locator('.session-chat-composer').boundingBox()
    expect(cardBounds.y + cardBounds.height).toBeLessThanOrEqual(composerBounds.y + 1)
    await page.setViewportSize({ width: 393, height: 480 })
    await expect(back).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393)
  })

  test('unconfirmed submission stays disabled through subsequent inspections', async ({ page }) => {
    let sent = 0
    await page.route('**/input-prompt/choice', route => {
      sent++
      return route.fulfill({ status: 409, json: { error: { code: 'OUTCOME_UNCONFIRMED' }, key_sent: true } })
    })
    await page.goto('/s/sess-001')
    const once = page.getByRole('button', { name: '1. Yes, proceed' })
    await expect(once).toBeEnabled(); await once.click()
    await expect(page.getByText(/Choice sent, but clearing was not confirmed/)).toBeVisible()
    await page.waitForTimeout(2200)
    await expect(once).toBeDisabled()
    expect(sent).toBe(1)
  })

  test('persistent scope requires a second explicit confirmation', async ({ page }) => {
    const choices = []
    await page.route('**/input-prompt/choice', route => {
      choices.push(route.request().postDataJSON())
      return route.fulfill({ json: { outcome: 'verified', key_sent: true, verified: true } })
    })
    await page.goto('/s/sess-001')
    const option = page.getByRole('button', { name: "2. Yes, and don't ask again for curl" })
    await expect(option).toBeEnabled(); await option.click()
    await expect(page.getByText(/persistent permission/)).toBeVisible()
    expect(choices).toEqual([])
    await page.getByRole('button', { name: 'Confirm this scope' }).click()
    await expect.poll(() => choices.length).toBe(1)
    expect(choices[0]).toEqual({ prompt_id: 'prompt-a', choice: '2', confirm_scope: true })
  })

  test('changed prompt is freshly inspected and requires a new tap', async ({ page }) => {
    let current = prompt, sent = 0
    await page.route('**/api/sessions/sess-001/input-prompt', route => route.fulfill({ json: current }))
    await page.route('**/input-prompt/choice', route => {
      sent++
      current = { ...prompt, prompt_id: 'prompt-b', context: '$ git status' }
      return route.fulfill({ status: 409, json: { error: { code: 'PROMPT_CHANGED' } } })
    })
    await page.goto('/s/sess-001')
    const once = page.getByRole('button', { name: '1. Yes, proceed' })
    await expect(once).toBeEnabled(); await once.click()
    await expect(page.getByText('$ git status', { exact: true })).toBeVisible()
    await expect(page.getByText(/Prompt changed or was already answered/)).toBeVisible()
    await expect(once).toBeEnabled()
    expect(sent).toBe(1)
  })

  test('read-only mode shows the prompt with disabled choices', async ({ page }) => {
    await page.route('**/api/settings', async route => {
      const data = await (await route.fetch()).json()
      await route.fulfill({ json: { ...data, readOnly: true } })
    })
    await page.goto('/s/sess-001')
    await expect(page.getByRole('button', { name: '1. Yes, proceed' })).toBeDisabled()
    await expect(page.getByText('Answering is disabled in read-only mode or when web mutations are off.')).toBeVisible()
  })

  test('undetected menus keep an explicit Terminal fallback', async ({ page }) => {
    await page.route('**/api/sessions/sess-001/input-prompt', route => route.fulfill({ json: { supported: true, tool: 'codex' } }))
    await page.goto('/s/sess-001')
    await expect(page.getByText('This menu cannot be safely answered in Chat yet.')).toBeVisible()
    await page.getByRole('link', { name: 'Open Terminal' }).click()
    await expect(page.locator('.term-frame')).toBeVisible()
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Return to Chat', exact: true }).click()
    await expect(page.locator('.term-frame')).toHaveCount(0)
  })

  test('does not inspect menus while browsing the session list', async ({ page }) => {
    const inspections = []
    page.on('request', request => { if (request.url().endsWith('/input-prompt')) inspections.push(request.url()) })
    await page.goto('/')
    await expect(page.locator('[data-testid="phone-shell"]')).toBeVisible()
    await page.waitForTimeout(300)
    expect(inspections).toEqual([])
    await page.locator('.phone-session', { hasText: 'agent-deck' }).click()
    await expect(page.getByRole('region', { name: 'Agent input prompt' })).toBeVisible()
    expect(inspections.length).toBeGreaterThan(0)
  })
})
