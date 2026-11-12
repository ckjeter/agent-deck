import { test, expect } from '@playwright/test'

// A phone turned sideways is wider than the 720px phone breakpoint. It must
// keep the phone shell: the desktop layout is unusable at that height.
test.describe('phone in landscape', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone project only')
  test.use({ serviceWorkers: 'block', hasTouch: true, isMobile: true })

  test.beforeEach(async ({ request }) => {
    await request.post('/__fixture/reset')
  })

  test('keeps the phone shell when a touch phone rotates to landscape and back', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="phone-shell"]')).toBeVisible()
    await page.setViewportSize({ width: 852, height: 393 })
    await page.waitForTimeout(300)
    await expect(page.locator('[data-testid="phone-shell"]')).toBeVisible()
    await expect(page.locator('#app-root-grid')).toHaveCount(0)
    await expect(page.locator('.phone-sessions-screen .phone-header')).toHaveCSS('height', '44px')
    await page.setViewportSize({ width: 393, height: 852 })
    await expect(page.locator('[data-testid="phone-shell"]')).toBeVisible()
  })
})

test.describe('short desktop window', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone project only')
  test.use({ serviceWorkers: 'block' })

  test('a short window without touch keeps the desktop layout', async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await page.setViewportSize({ width: 1000, height: 450 })
    await page.goto('/')
    await expect(page.locator('#app-root-grid')).toBeVisible()
    await expect(page.locator('[data-testid="phone-shell"]')).toHaveCount(0)
  })
})
