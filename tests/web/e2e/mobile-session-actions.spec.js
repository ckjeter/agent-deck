// e2e/mobile-session-actions.spec.js -- phone Rename, Move to group,
// Archive/Restore and Delete/Undo, reached by long-pressing a session row or
// from the conversation's session menu. Runs against the shared web fixture
// (mutations allowed); read-only and remote cases are routed.
import { test, expect } from '@playwright/test'

const ROW = '.phone-session[data-session-id="sess-001"]'

async function longPress(page, locator) {
  const box = await locator.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
}

async function groupOf(request, id) {
  const sessions = (await (await request.get('/api/sessions')).json()).sessions
  return sessions.find(s => s.id === id)?.groupPath
}

test.describe('phone session actions', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone layout only')
  test.use({ serviceWorkers: 'block' })

  test.beforeEach(async ({ page, request }) => {
    expect((await request.post('/__fixture/reset')).status()).toBe(204)
    await page.route(/\/api\/sessions\/[^/]+\/output/, route => route.fulfill({ json: {
      messages: [{ id: 'answer', role: 'assistant', content: 'Phone conversation response' }], content_version: 'v1',
    } }))
    await page.route(/\/api\/sessions\/[^/]+\/send-status/, route => route.fulfill({ json: { sends: [], content_version: 'q1' } }))
  })

  test('long-press opens the sheet, a tap opens the session, a scroll does neither', async ({ page }) => {
    await page.goto('/')
    const row = page.locator(ROW)
    await expect(row).toBeVisible()

    const box = await row.boundingBox()
    const at = { button: 0, clientX: box.x + 20, clientY: box.y + 20, pointerType: 'touch', isPrimary: true }
    await row.dispatchEvent('pointerdown', at)
    await row.dispatchEvent('pointermove', { ...at, clientY: at.clientY + 40 })
    await page.waitForTimeout(700)
    await row.dispatchEvent('pointerdown', at)
    await row.dispatchEvent('pointercancel', at)
    await page.waitForTimeout(700)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)

    await longPress(page, row)
    const sheet = page.getByRole('dialog', { name: 'Actions for agent-deck' })
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(/\/$/)
    await expect(sheet.locator('.phone-action-list button')).toHaveText(['Rename', 'Move to group', 'Archive', 'Delete'])
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await expect(sheet).toHaveCount(0)

    await row.click()
    await expect(page).toHaveURL(/\/s\/sess-001$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('rename saves on Enter and shows the API validation error inline', async ({ page }) => {
    await page.goto('/')
    await longPress(page, page.locator(ROW))
    await page.getByRole('button', { name: 'Rename' }).click()
    const input = page.getByRole('textbox', { name: 'Session title' })
    await expect(input).toHaveValue('agent-deck')
    await expect(input).toBeFocused()
    expect(await input.evaluate(el => getComputedStyle(el).fontSize)).toBe('16px')
    await input.fill('')
    await input.press('Enter')
    await expect(page.getByRole('alert').filter({ hasText: 'title cannot be empty' })).toBeVisible()
    await expect(page.getByRole('dialog')).toBeVisible()
    await input.fill('Phone renamed 中文')
    await input.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator(ROW)).toContainText('Phone renamed 中文')
  })

  test('move from the session menu lists the tree, shows the restart notice, and creates a new group', async ({ page, request }) => {
    await page.goto('/s/sess-001')
    await expect(page.getByText('Phone conversation response', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Move to group' }).click()
    const sheet = page.getByRole('dialog', { name: 'Actions for agent-deck' })
    await expect(sheet.getByRole('button', { name: /work\s*Current/ })).toHaveAttribute('aria-current', 'true')
    await expect(sheet.getByRole('button', { name: /work\s*Current/ })).toBeDisabled()
    const innotrade = sheet.getByRole('button', { name: /^innotrade/ })
    expect(await innotrade.evaluate(el => el.style.getPropertyValue('--group-depth'))).toBe('1')
    await sheet.getByRole('button', { name: /^personal/ }).click()
    await expect(sheet.getByRole('status')).toContainText('Restart the session')
    expect(await groupOf(request, 'sess-001')).toBe('personal')
    await sheet.getByRole('button', { name: 'Done' }).click()

    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Move to group' }).click()
    await page.getByRole('button', { name: 'New group…' }).click()
    const name = page.getByRole('textbox', { name: 'New group name' })
    await name.fill('phone-made')
    await name.press('Enter')
    // Leaving the fixture's config-dir group ("personal") needs a restart too.
    await expect(sheet.getByRole('status')).toContainText('Moved “agent-deck” to phone-made.')
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await groupOf(request, 'sess-001')).toBe('phone-made')
  })

  test('archive returns to the list and Archived restores the session stopped', async ({ page, request }) => {
    await page.goto('/')
    await page.locator(ROW).click()
    await expect(page).toHaveURL(/\/s\/sess-001$/)
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Archive' }).click()
    const sheet = page.getByRole('dialog', { name: 'Actions for agent-deck' })
    await expect(sheet).toContainText('Archive session?')
    await expect(sheet).toContainText('Restoring does not restart it.')
    await sheet.getByRole('button', { name: 'Archive' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator(ROW)).toHaveCount(0)

    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('button', { name: 'Archived sessions' }).click()
    const archived = page.getByRole('dialog', { name: 'Archived sessions' })
    await expect(archived).toContainText('agent-deck')
    await archived.getByRole('button', { name: 'Restore agent-deck' }).click()
    await expect(archived).toContainText('No archived sessions.')
    await expect(archived.getByRole('status')).toHaveText('Restored “agent-deck”. It stays stopped until you start it.')
    await archived.getByRole('button', { name: 'Done' }).click()
    await expect(page.locator(ROW)).toBeVisible()
    const restored = (await (await request.get('/api/sessions')).json()).sessions.find(s => s.id === 'sess-001')
    expect(restored.status).toBe('stopped')
  })

  test('delete names the session, returns to the list, and Undo brings it back', async ({ page }) => {
    await page.goto('/')
    await page.locator(ROW).click()
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    const sheet = page.getByRole('dialog', { name: 'Actions for agent-deck' })
    await expect(sheet).toContainText('agent-deck will be deleted everywhere')
    await expect(sheet).toContainText('You can undo for 30 seconds.')
    await sheet.getByRole('button', { name: 'Delete' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator(ROW)).toHaveCount(0)
    await expect(page.getByText('Deleted “agent-deck”')).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByText('Restored “agent-deck”')).toBeVisible()
    await expect(page.locator(ROW)).toBeVisible()
  })

  test('read-only mode shows the actions disabled with the reason', async ({ page }) => {
    await page.route('**/api/settings', async route => {
      const response = await route.fetch()
      await route.fulfill({ json: { ...(await response.json()), readOnly: true } })
    })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
    await longPress(page, page.locator(ROW))
    const sheet = page.getByRole('dialog', { name: 'Actions for agent-deck' })
    for (const name of ['Rename', 'Move to group', 'Archive', 'Delete']) await expect(sheet.getByRole('button', { name })).toBeDisabled()
    await expect(sheet.getByRole('note')).toHaveText('This server is read-only. Session changes are turned off.')
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await page.locator(ROW).click()
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Session menu' }).getByRole('button', { name: 'Archive' })).toBeDisabled()
  })

  test("a remote session's sheet shows every action disabled with the reason", async ({ page }) => {
    await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
      { name: 'mac', online: true, sessions: [{ id: 'r1', title: 'Remote work', group: 'Work', tool: 'claude', status: 'running' }] },
    ] } }))
    await page.goto('/')
    const row = page.getByRole('region', { name: 'Remote mac' }).locator('.phone-session[data-session-id="r1"]')
    await longPress(page, row)
    const sheet = page.getByRole('dialog', { name: 'Actions for Remote work' })
    for (const name of ['Rename', 'Move to group', 'Archive', 'Delete']) await expect(sheet.getByRole('button', { name })).toBeDisabled()
    await expect(sheet.getByRole('note')).toContainText('on mac can only be renamed, moved, archived or deleted on that machine')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
  })
})
