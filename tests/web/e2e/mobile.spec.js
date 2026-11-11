import { test, expect } from '@playwright/test'

test.describe('phone session remote', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [{ id: 'answer', role: 'assistant', content: 'Phone conversation response' }], content_version: 'v1',
    } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [], content_version: 'q1' } }))
  })

  test('list and Chat never attach or resize a terminal, including a remembered Terminal preference', async ({ page }) => {
    const sockets = [], secondary = []
    page.on('websocket', ws => sockets.push(ws.url()))
    page.on('request', req => { if (/\/events\/command-center|\/api\/(costs|system)/.test(req.url())) secondary.push(req.url()) })
    await page.addInitScript(() => localStorage.setItem('agentdeck.sessionView', 'terminal'))
    await page.goto('/')
    await expect(page.locator('[data-testid="phone-shell"]')).toBeVisible()
    await expect(page.locator('#app-root-grid')).toHaveCount(0)
    await expect(page.locator('[data-testid="mobile-tabs"]')).toHaveCount(0)
    await page.locator('.phone-session', { hasText: 'agent-deck' }).click()
    await expect(page.getByText('Phone conversation response', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/s\/sess-001$/)
    await page.setViewportSize({ width: 390, height: 600 })
    await page.waitForTimeout(500)
    expect(sockets).toEqual([])
    expect(secondary).toEqual([])
    await page.reload()
    await expect(page.getByText('Phone conversation response', { exact: true })).toBeVisible()
    await page.waitForTimeout(300)
    expect(sockets).toEqual([])
  })

  test('explicit Terminal attaches with ignore-size and closes on return to Chat', async ({ page }) => {
    const sockets = [], closed = [], sent = []
    page.on('websocket', ws => {
      sockets.push(ws.url())
      ws.on('close', () => closed.push(ws.url()))
      ws.on('framesent', event => sent.push(String(event.payload)))
    })
    await page.goto('/s/sess-001')
    await expect(page.getByText('Phone conversation response', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Open Terminal', exact: true }).click()
    await expect(page.locator('.term-frame')).toBeVisible()
    const back = page.getByRole('button', { name: 'Back to sessions' })
    await expect(page.locator('.phone-header button').first()).toHaveAttribute('aria-label', 'Back to sessions')
    expect(await back.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    await expect.poll(() => sockets.length).toBe(1)
    expect(new URL(sockets[0]).searchParams.get('ignore-size')).toBe('1')
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Return to Chat', exact: true }).click()
    await expect(page.locator('.term-frame')).toHaveCount(0)
    await expect.poll(() => closed.length).toBe(1)
    const count = sent.length
    await page.setViewportSize({ width: 390, height: 550 })
    await page.waitForTimeout(500)
    expect(sockets).toHaveLength(1)
    expect(sent).toHaveLength(count)
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
  })

  test('collapse is shared through PATCH, and Back restores the filtered list', async ({ page, request }) => {
    await page.goto('/')
    const work = page.locator('[data-group-path="work"] > .phone-group-heading button')
    await expect(work).toHaveAttribute('aria-expanded', 'true')
    await work.click()
    await expect(work).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => {
      const snapshot = await (await request.get('/api/menu')).json()
      return snapshot.items.find(i => i.group?.path === 'work').group.expanded
    }).toBe(false)
    await work.click()
    await expect(work).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search sessions or groups' }).fill('agent-deck')
    await page.locator('.phone-session', { hasText: 'agent-deck' }).click()
    await expect(page.getByText('Phone conversation response', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to sessions' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('textbox', { name: 'Search sessions or groups' })).toHaveValue('agent-deck')
  })

  test('More exposes desktop layout and permits returning to the phone shell', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'More' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Use desktop layout' }).click()
    await expect(page.locator('#app-root-grid')).toBeVisible()
    await expect(page.locator('[data-testid="phone-shell"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Phone layout', exact: true }).click()
    await expect(page.locator('[data-testid="phone-shell"]')).toBeVisible()
    await expect(page.locator('#app-root-grid')).toHaveCount(0)
  })

  test('group deep links reveal the list, and the composer fits the measured viewport', async ({ page }) => {
    await page.goto('/g/work%2Finnotrade')
    await expect(page.locator('[data-group-path="work/innotrade"]')).toBeVisible()
    await expect(page.locator('[data-testid="group-stats-panel"]')).toHaveCount(0)
    await page.goto('/s/sess-001')
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
    await page.setViewportSize({ width: 393, height: 480 })
    const dimensions = await page.locator('.phone-shell').evaluate(el => ({
      bottom: el.getBoundingClientRect().bottom, height: innerHeight,
      width: document.documentElement.scrollWidth, viewport: innerWidth,
    }))
    expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.height)
    expect(dimensions.width).toBe(dimensions.viewport)
  })
})
