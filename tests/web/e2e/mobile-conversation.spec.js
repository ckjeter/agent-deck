import { test, expect } from '@playwright/test'

test.describe('phone conversation readability', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [
        { id: 'user-1', role: 'user', content: 'Please explain the result.' },
        { id: 'assistant-1', role: 'assistant', content: 'The conversation should have room to breathe.' },
      ], content_version: 'v1',
    } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [], content_version: 'q1' } }))
  })

  test('measures the message viewport at 390 by 844', async ({ page, request }) => {
    await request.post('/__fixture/session/sess-001/status?to=waiting')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/s/sess-001')
    await expect(page.getByText('The conversation should have room to breathe.', { exact: true })).toBeVisible()
    const metrics = await page.evaluate(() => {
      const height = selector => {
        const element = document.querySelector(selector)
        return element ? Math.round(element.getBoundingClientRect().height * 100) / 100 : 0
      }
      return {
        viewport: [innerWidth, innerHeight],
        header: height('.phone-header'),
        context: height('.phone-context'),
        viewToggle: height('.session-view-toggle'),
        waitingBanner: height('.phone-attention-banner.waiting'),
        composer: height('.session-chat-composer'),
        messages: height('.session-chat-output'),
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    console.log('CHAT_VIEWPORT_METRICS ' + JSON.stringify(metrics))
    expect(metrics.viewport).toEqual([390, 844])
    expect(metrics.header).toBeLessThanOrEqual(54)
    expect(metrics.context).toBe(0)
    expect(metrics.viewToggle).toBe(0)
    expect(metrics.waitingBanner).toBe(0)
    expect(metrics.messages).toBeGreaterThan(620)
    expect(metrics.pageWidth).toBe(390)
    await expect(page.getByRole('img', { name: 'Session status: Waiting for you' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Session menu', exact: true })).toBeVisible()
    await expect(page.locator('.phone-header button').first()).toHaveAttribute('aria-label', 'Back to sessions')
  })

  test('renders readable roles and scrolls wide Markdown inside its own blocks', async ({ page }) => {
    await page.unroute(/\/api\/sessions\/[^/]+\/output/)
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [
        { id: 'user-1', role: 'user', content: 'Show the full result.' },
        { id: 'assistant-1', role: 'assistant', content: '# Result\n\n> Quoted context\n\n- parent\n  - child\n\n| Name | Very long value that must stay inside the table |\n| --- | --- |\n| alpha |abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz|\n\n```js\nconst aVeryLongIdentifier = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"\n```\n\n[Safe link](https://example.test)\n\n---' },
      ], content_version: 'v1',
    } }))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/s/sess-001')
    await expect(page.getByRole('heading', { name: 'Result', exact: true })).toBeVisible()
    await expect(page.locator('blockquote')).toContainText('Quoted context')
    await expect(page.locator('.session-chat-message.assistant li li')).toHaveText('child')
    await expect(page.getByRole('link', { name: 'Safe link' })).toHaveAttribute('href', 'https://example.test')
    await expect(page.getByRole('button', { name: 'Copy code', exact: true })).toBeVisible()
    await expect(page.locator('hr')).toBeVisible()

    const scrolling = await page.evaluate(() => {
      const metrics = selector => {
        const el = document.querySelector(selector)
        return { client: el.clientWidth, scroll: el.scrollWidth }
      }
      return {
        table: metrics('.markdown-table-scroll'),
        code: metrics('.markdown-code pre'),
        page: document.documentElement.scrollWidth,
      }
    })
    expect(scrolling.table.scroll).toBeGreaterThan(scrolling.table.client)
    expect(scrolling.code.scroll).toBeGreaterThan(scrolling.code.client)
    expect(scrolling.page).toBe(390)

    const assistant = page.locator('.session-chat-message.assistant')
    await expect(assistant).toHaveCSS('border-top-width', '0px')
    const outputBox = await page.locator('.session-chat-output').boundingBox()
    const userBubble = await page.locator('.session-chat-message.user [data-message-id]').boundingBox()
    expect(userBubble.x).toBeGreaterThan(outputBox.x)
    expect(userBubble.width).toBeLessThan(outputBox.width * 0.9)
  })

  test('expands the composer, grows with text, and caps long drafts without moving Send offscreen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    const composer = page.locator('.session-chat-composer')
    await expect(input).toBeEnabled()
    await expect(composer).toHaveAttribute('data-expanded', 'false')
    expect((await composer.boundingBox()).height).toBeLessThanOrEqual(60)
    await input.focus()
    await expect(composer).toHaveAttribute('data-expanded', 'true')
    const empty = (await input.boundingBox()).height
    await input.fill('A line of text\n'.repeat(6))
    expect((await input.boundingBox()).height).toBeGreaterThan(empty)
    await input.fill('A line of text\n'.repeat(40))
    const full = await input.boundingBox()
    expect(full.height).toBeLessThanOrEqual(192)
    expect(await input.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeEnabled()
    expect((await send.boundingBox()).y + (await send.boundingBox()).height).toBeLessThanOrEqual(844)
    await input.fill('Short draft')
    expect((await input.boundingBox()).height).toBe(empty)
    await input.fill('')
    await page.getByRole('button', { name: 'Dismiss keyboard', exact: true }).click()
    await expect(composer).toHaveAttribute('data-expanded', 'false')
    await expect(input).not.toBeFocused()
    console.log('COMPOSER_METRICS ' + JSON.stringify({ collapsed: (await composer.boundingBox()).height, expandedInput: empty, maxInput: full.height }))
  })

  test('respects reduced motion for screen, sheet, and composer transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/s/sess-001')
    await expect(page.locator('.phone-conversation')).toHaveCSS('animation-name', 'none')
    await expect(page.locator('.session-chat-composer')).toHaveCSS('transition-duration', '0s')
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Session menu', exact: true })).toHaveCSS('animation-name', 'none')
  })

})
