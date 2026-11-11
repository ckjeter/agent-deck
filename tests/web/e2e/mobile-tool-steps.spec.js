import { test, expect } from '@playwright/test'

const tool = (id, kind, title, extra = {}) => ({
  id, role: 'assistant', tools: true,
  tool: { kind, title, finished: true, ...extra },
})

test.describe('phone live tool steps', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  test('groups a running tool-heavy transcript and follows new steps without moving the composer', async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await request.post('/__fixture/session/sess-001/status?to=running')
    let updated = false
    await page.route(/\/api\/sessions\/sess-001\/output/, route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('if-version') === 'v2' || (!updated && url.searchParams.get('since') === 'c1')) return route.fulfill({ status: 204 })
      if (updated) {
        updated = true
        return route.fulfill({ json: {
          messages: [tool('bash-4', 'bash', 'Run web tests', { target: 'go test ./internal/web/...', finished: false })],
          updates: [{ id: 'bash-3', role: 'assistant', tools: true, tool: { result: 'Exit code 0', finished: true } }],
          through_cursor: 'c2', content_version: 'v2',
        } })
      }
      return route.fulfill({ json: {
        messages: [
          { id: 'user', role: 'user', content: 'Fix the frozen-looking turn.' },
          { id: 'assistant', role: 'assistant', content: 'I will inspect and test it.\n\n'.repeat(40) },
          tool('think', 'thinking', 'Thinking', { detail: 'Check <img src=x onerror=alert(1)> safely' }),
          tool('bash-1', 'bash', 'Inspect files', { target: 'rg "Tool activity" internal/web', result: '<img src=x onerror=alert(1)>'.repeat(7) }),
          tool('bash-2', 'bash', 'Read rows', { target: 'sed -n 1,80p internal/recall/query/rows.go', result: 'Read 80 lines' }),
          tool('bash-3', 'bash', 'Run tests', { target: 'go test ./...', finished: false }),
          tool('edit-1', 'edit', 'Edited SessionChat.js', { target: 'internal/web/static/app/SessionChat.js', added: 4, removed: 2 }),
          tool('edit-2', 'edit', 'Edited history.go', { target: 'internal/web/session_chat_history.go', result: 'Added 20 lines' }),
        ], through_cursor: 'c1', content_version: 'v1',
      } })
    })
    await page.route(/\/api\/sessions\/sess-001\/send-status/, route => route.fulfill({ json: { sends: [], content_version: 'q1' } }))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/s/sess-001')

    const summary = page.locator('.session-tool-summary')
    await expect(summary).toContainText('Ran 3 commands, edited 2 files, thinking')
    await expect(summary).toHaveAttribute('aria-expanded', 'false')
    await expect(summary).toContainText('Edited history.go')
    await expect(page.getByRole('img', { name: 'Live tool activity' })).toBeVisible()
    await expect(page.locator('.session-tool-steps')).toHaveCount(0)
    const composer = page.locator('.session-chat-composer')
    const before = await composer.boundingBox()

    await summary.click()
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.session-tool-steps li')).toHaveCount(6)
    await expect(page.getByText('go test ./...', { exact: true })).toBeVisible()
    await expect(page.getByText('+4 / -2', { exact: true })).toBeVisible()
    await expect(page.getByText('Check <img src=x onerror=alert(1)> safely', { exact: true })).toBeVisible()
    await expect(page.locator('.session-tool-steps img')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    await page.evaluate(() => {
      const output = document.querySelector('.session-chat-output')
      output.scrollTop = output.scrollHeight
      output.dispatchEvent(new Event('scroll'))
    })

    updated = true
    await expect(summary).toContainText('Ran 4 commands, edited 2 files, thinking', { timeout: 7000 })
    await expect(summary).toContainText('Run web tests')
    await expect(summary).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.session-tool-steps li')).toHaveCount(7)
    await expect(page.getByText('go test ./internal/web/...', { exact: true })).toBeVisible()
    await expect(page.getByText('Exit code 0', { exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.session-chat-output').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2)
    expect(await composer.boundingBox()).toEqual(before)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.session-tool-live-dot')).toHaveCSS('animation-name', 'none')
    await request.post('/__fixture/session/sess-001/status?to=waiting')
    await expect(page.getByRole('img', { name: 'Live tool activity' })).toHaveCount(0, { timeout: 7000 })
    expect(await composer.boundingBox()).toEqual(before)
  })
})
