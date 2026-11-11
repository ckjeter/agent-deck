import { test, expect } from '@playwright/test'

test.describe('phone keyboard visual viewport', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone layout only')
  test.use({ serviceWorkers: 'block' })

  test('header, Back, and native composer stay within a panned keyboard viewport', async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: { messages: [
      { id: 'answer', role: 'assistant', content: 'Long reply\n\n'.repeat(100) },
    ], content_version: 'v1' } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [] } }))
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await expect(input).toBeVisible()
    await expect(input).toBeEnabled()
    const back = page.getByRole('button', { name: 'Back to sessions' })
    await expect(page.locator('.phone-header').getByRole('button', { name: 'Back to sessions' })).toBeVisible()
    await expect(page.locator('.phone-header button').first()).toHaveAttribute('aria-label', 'Back to sessions')
    expect(await back.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
    await input.fill('Typing with 中文 IME and dictation')
    const before = await page.locator('.session-chat-output').evaluate(el => el.clientHeight)
    // Headless WebKit has no OS keyboard. Keep its real layout engine and
    // emulate the visualViewport resize/pan events Safari emits on focus.
    for (const offsetTop of [0, 120]) {
      await page.evaluate(offsetTop => {
        const visual = window.visualViewport
        Object.defineProperties(visual, {
          height: { configurable: true, get: () => 376 },
          offsetTop: { configurable: true, get: () => offsetTop },
          pageTop: { configurable: true, get: () => window.scrollY + offsetTop },
        })
        visual.dispatchEvent(new Event('resize'))
        visual.dispatchEvent(new Event('scroll'))
      }, offsetTop)
      await expect.poll(async () => page.evaluate(() => {
        const visual = window.visualViewport
        const header = document.querySelector('.phone-header').getBoundingClientRect()
        const composer = document.querySelector('.session-chat-composer').getBoundingClientRect()
        const back = document.querySelector('[aria-label="Back to sessions"]').getBoundingClientRect()
        const output = document.querySelector('.session-chat-output').getBoundingClientRect()
        return header.top >= visual.offsetTop - 1 && composer.bottom <= visual.offsetTop + visual.height + 1 &&
          back.top >= header.top - 1 && back.bottom <= header.bottom + 1 && output.height > 80
      })).toBe(true)
      expect(await page.locator('.session-chat-output').evaluate(el => el.clientHeight)).toBeLessThan(before)
      expect(await input.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
      await expect(input).toBeFocused()
    }
    await page.evaluate(() => {
      for (const name of ['height', 'offsetTop', 'pageTop']) delete window.visualViewport[name]
      window.visualViewport.dispatchEvent(new Event('resize'))
    })
    await expect(input).toHaveValue('Typing with 中文 IME and dictation')
  })
})
