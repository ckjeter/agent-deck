import { test, expect } from '@playwright/test'

const key = (profile, id) => 'agentdeck.phoneDraft.v1:' + JSON.stringify([profile, id])

test.describe('phone draft handoff and persistence', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })

  let desktop, takes, sends
  test.beforeEach(async ({ page, request }) => {
    await request.post('/__fixture/reset')
    desktop = { visible: true, foreign: true, draft: 'Desktop 中文 draft', fingerprint: 'draft-1' }
    takes = []; sends = []
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: { messages: [], content_version: 'v1' } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [], content_version: 'q1' } }))
    await page.route(/\/api\/sessions\/[^/]+\/composer$/, route => route.fulfill({ json: desktop }))
    await page.route(/\/api\/sessions\/[^/]+\/composer\/take$/, async route => {
      takes.push(route.request().postDataJSON())
      const draft = desktop.draft
      desktop = { visible: true, foreign: false, draft: '' }
      await route.fulfill({ json: { draft, verified: true } })
    })
    await page.route(/\/api\/sessions\/[^/]+\/send$/, async route => {
      sends.push(route.request().postDataJSON())
      await route.fulfill({ status: 202, json: { send_id: 'draft-send', state: 'queued' } })
    })
  })

  test('moves into the editable phone composer, preserves existing text, and never sends automatically', async ({ page }) => {
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Phone thought')
    await expect(page.getByText('Desktop has an unsent draft: Desktop 中文 draft')).toBeVisible()
    await page.getByRole('button', { name: 'Move here', exact: true }).click()
    await expect(input).toHaveValue('Phone thought\n\nDesktop 中文 draft')
    await expect(page.getByRole('complementary', { name: 'Desktop draft' })).toHaveCount(0)
    expect(takes).toEqual([{ fingerprint: 'draft-1' }])
    expect(sends).toEqual([])
    await page.reload()
    await expect(input).toHaveValue('Phone thought\n\nDesktop 中文 draft')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(393)
  })

  test('discard requires confirmation, clears only the desktop draft, and never sends', async ({ page }) => {
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Keep phone draft')
    page.once('dialog', dialog => dialog.dismiss())
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    expect(takes).toEqual([])
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Discard', exact: true })).toHaveCount(0)
    await expect(input).toHaveValue('Keep phone draft')
    expect(takes).toHaveLength(1)
    expect(sends).toEqual([])
  })

  test('changed draft is refreshed without replacing phone text', async ({ page }) => {
    await page.route(/\/api\/sessions\/[^/]+\/composer\/take$/, async route => {
      desktop = { ...desktop, draft: 'New desktop text', fingerprint: 'draft-2' }
      await route.fulfill({ status: 409, json: { error: { code: 'DRAFT_CHANGED', message: 'Desktop draft changed; review it again' } } })
    })
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Phone thought')
    await page.getByRole('button', { name: 'Move here', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Desktop draft changed; review it again')
    await expect(page.getByText('Desktop has an unsent draft: New desktop text')).toBeVisible()
    await expect(input).toHaveValue('Phone thought')
  })

  test('persists across reload and session switching, then clears on successful send', async ({ page }) => {
    desktop = { visible: true, foreign: false }
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Unsent 中文\nSecond line')
    await page.reload()
    await expect(input).toHaveValue('Unsent 中文\nSecond line')
    await page.getByRole('button', { name: 'Back to sessions' }).click()
    await page.locator('.phone-session', { hasText: 'frontend' }).click()
    await expect(input).toHaveValue('')
    await input.fill('Another session')
    await page.getByRole('button', { name: 'Back to sessions' }).click()
    await page.locator('.phone-session', { hasText: 'agent-deck' }).click()
    await expect(input).toHaveValue('Unsent 中文\nSecond line')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(input).toHaveValue('')
    expect(sends).toEqual([{ text: 'Unsent 中文\nSecond line', client_id: expect.any(String) }])
    expect(await page.evaluate(key => localStorage.getItem(key), key('fixture', 'sess-001'))).toBeNull()
    await page.reload()
    await expect(input).toHaveValue('')
  })

  test('cleans deleted and expired drafts while isolating other profiles', async ({ page }) => {
    desktop = { visible: true, foreign: false }
    await page.goto('/')
    await page.evaluate(() => {
      const save = (profile, id, text, age = 0) => localStorage.setItem('agentdeck.phoneDraft.v1:' + JSON.stringify([profile, id]), JSON.stringify({ text, updatedAt: Date.now() - age }))
      save('fixture', 'sess-001', 'Keep')
      save('fixture', 'sess-002', 'Expired', 7 * 86400000 + 1)
      save('fixture', 'deleted-session', 'Gone')
      save('other-profile', 'different-session', 'Other profile')
      save('fixture', 'remote:offline:unknown', 'Offline remote draft')
    })
    await page.reload()
    await page.locator('.phone-session', { hasText: 'agent-deck' }).click()
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Keep')
    const values = await page.evaluate(keys => keys.map(key => localStorage.getItem(key)), [key('fixture', 'sess-002'), key('fixture', 'deleted-session'), key('other-profile', 'different-session'), key('fixture', 'remote:offline:unknown')])
    expect(values[0]).toBeNull(); expect(values[1]).toBeNull()
    expect(values[2]).toContain('Other profile'); expect(values[3]).toContain('Offline remote draft')
  })

  test('shows the draft notice when a send fails and retains the unsent phone text', async ({ page }) => {
    desktop = { visible: true, foreign: false }
    await page.route(/\/api\/sessions\/[^/]+\/send$/, async route => {
      desktop = { visible: true, foreign: true, draft: 'Accidental desktop key', fingerprint: 'draft-2' }
      await route.fulfill({ status: 409, json: { error: { code: 'FOREIGN_DRAFT', message: 'composer holds a foreign draft' } } })
    })
    await page.goto('/s/sess-001')
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('Still unsent')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Desktop has an unsent draft: Accidental desktop key')).toBeVisible()
    await expect(input).toHaveValue('Still unsent')
    await page.reload()
    await expect(input).toHaveValue('Still unsent')
  })

  test('inspects only the open local Chat and stops polling on Back', async ({ page }) => {
    const seen = []
    page.on('request', request => { if (/\/composer$/.test(request.url())) seen.push(request.url()) })
    await page.goto('/')
    await expect(page.locator('.phone-session').first()).toBeVisible()
    expect(seen).toEqual([])
    await page.locator('.phone-session', { hasText: 'agent-deck' }).click()
    await expect(page.getByRole('button', { name: 'Move here' })).toBeVisible()
    expect(seen.every(url => url.includes('/sess-001/'))).toBe(true)
    await page.getByRole('button', { name: 'Back to sessions' }).click()
    const count = seen.length
    await page.waitForTimeout(2200)
    expect(seen).toHaveLength(count)
  })
})
