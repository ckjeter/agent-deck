import { test, expect } from '@playwright/test'

const group = (path, count = 0) => ({ type: 'group', level: path.split('/').length - 1,
  group: { path, name: path.split('/').at(-1), expanded: true, sessionCount: count } })
const session = (id, path, level = path.split('/').length, parent = '') => ({ type: 'session', level,
  session: { id, title: id, tool: 'codex', groupPath: path, parentSessionId: parent, status: 'running', latestPrompt: 'Review the current implementation' } })

// A stand-in EventSource that delivers one menu snapshot and stays open, so a
// measurement sees the healthy connected state instead of a fulfilled stream
// that closes and reconnects.
async function holdMenuStream(page, items) {
  await page.addInitScript(snapshot => {
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2
      constructor(url) {
        super(); this.url = String(url); this.readyState = 1
        if (this.url.includes('/events/menu')) setTimeout(() => this.dispatchEvent(new MessageEvent('menu', { data: JSON.stringify(snapshot) })), 0)
      }
      close() { this.readyState = 2 }
    }
  }, { profile: 'work', items })
}

const settle = page => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
})

async function installMenu(page, items) {
  const snapshot = { profile: 'work', items }
  await page.route('**/api/menu', route => route.fulfill({ json: snapshot }))
  await page.route('**/events/menu', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: menu\ndata: ' + JSON.stringify(snapshot) + '\n\n' }))
  await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [] } }))
  await holdMenuStream(page, items)
}

test.describe('phone session tree', () => {
  test.skip(({ viewport }) => viewport.width > 720, 'phone shell only')
  test.use({ serviceWorkers: 'block' })
  test.beforeEach(async ({ request }) => { await request.post('/__fixture/reset') })

  test('measures visible session capacity at 390 by 844', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const items = [group('Work', 20), ...Array.from({ length: 20 }, (_, i) => session('Session ' + (i + 1), 'Work'))]
    await installMenu(page, items)
    await page.goto('/')
    await expect(page.locator('.phone-session')).toHaveCount(20)
    await settle(page)
    const metrics = await page.evaluate(() => {
      const bounds = selector => {
        const { y, height } = document.querySelector(selector).getBoundingClientRect()
        return { y, height }
      }
      const list = document.querySelector('.phone-list').getBoundingClientRect()
      const rows = [...document.querySelectorAll('.phone-session')].map(el => el.getBoundingClientRect())
      return { viewport: { width: innerWidth, height: innerHeight },
        header: bounds('.phone-sessions .phone-header'), list: bounds('.phone-list'), group: bounds('.phone-group-heading'),
        listStart: Math.round(list.y),
        rowHeight: rows[0].height, rowPitch: rows[1].y - rows[0].y,
        fullyVisibleRows: rows.filter(r => r.y >= list.y && r.bottom <= list.bottom).length }
    })
    console.log('SESSION_DENSITY ' + JSON.stringify(metrics))
    await testInfo.attach('session-density', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' })
    expect(metrics.rowHeight).toBeGreaterThanOrEqual(44)
    if (!process.env.SESSIONS_DENSITY_BASELINE) {
      expect(metrics.listStart).toBeLessThanOrEqual(45)
      expect(metrics.fullyVisibleRows).toBeGreaterThanOrEqual(13)
    }
  })

  test('uses local TUI depths and order, with nested groups and child guides', async ({ page }) => {
    await installMenu(page, [group('Work', 5), session('Parent', 'Work'),
      session('Child one', 'Work', 2, 'Parent'), session('Child two', 'Work', 2, 'Parent'),
      session('Orphan', 'Work', 1, 'missing'), group('Work/API', 1), session('API session', 'Work/API')])
    await page.goto('/')
    await expect(page.locator('.phone-session')).toHaveCount(5)
    expect(await page.locator('.phone-session').evaluateAll(rows => rows.map(r => r.dataset.sessionId)))
      .toEqual(['Parent', 'Child one', 'Child two', 'Orphan', 'API session'])
    const parent = page.locator('[data-session-id="Parent"]')
    const child = page.locator('[data-session-id="Child one"]')
    const orphan = page.locator('[data-session-id="Orphan"]')
    await expect(child).toHaveAttribute('data-nested', 'true')
    await expect(orphan).toHaveAttribute('data-nested', 'false')
    const boxes = await Promise.all([parent.boundingBox(), child.boundingBox(), orphan.boundingBox(),
      page.locator('[data-group-path="Work/API"] > .phone-group-heading').boundingBox(),
      page.locator('[data-session-id="API session"]').boundingBox()])
    expect(boxes[1].x - boxes[0].x).toBe(14)
    expect(boxes[2].x).toBe(boxes[0].x)
    expect(boxes[3].x).toBeGreaterThan(page.viewportSize().width * 0.03)
    expect(boxes[4].x - boxes[3].x).toBe(14)
    expect(await child.evaluate(el => getComputedStyle(el, '::before').borderLeftWidth)).toBe('1px')
    for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(44)

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search sessions or groups' }).fill('Child two')
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await expect(parent).toHaveAttribute('data-context-only', 'true')
    await expect(parent).toContainText('Parent context')
    await expect(page.locator('[data-session-id="Child two"]')).toHaveAttribute('data-last-child', 'true')
  })

  test('remote hierarchy handles parent data, default groups, collapse, and attention search', async ({ page }) => {
    await installMenu(page, [])
    await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
      { name: 'mac', online: true, sessions: [
        { id: 'child', title: 'Remote child', group: 'Work', parent_session_id: 'parent', status: 'waiting', substate: 'interactive-menu' },
        { id: 'parent', title: 'Remote parent', group: 'Work', status: 'running' },
        { id: 'grandchild', title: 'Remote grandchild', group: 'Work', parent_session_id: 'child', status: 'running' },
        { id: 'default', title: 'Ungrouped', group: '', status: 'running' },
      ] },
      { name: 'linux', online: true, sessions: [{ id: 'linux', title: 'Linux session', group: 'Work', status: 'running' }] },
    ] } }))
    await page.goto('/')
    const mac = page.getByRole('region', { name: 'Remote mac', exact: true })
    await expect(mac.locator('.phone-session')).toHaveCount(4)
    expect(await mac.locator('.phone-session').evaluateAll(rows => rows.map(r => r.dataset.sessionId)))
      .toEqual(['parent', 'child', 'grandchild', 'default'])
    await expect(mac.locator('[data-session-id="child"]')).toHaveAttribute('data-nested', 'true')
    await expect(mac.locator('[data-session-id="grandchild"]')).toHaveAttribute('data-nested', 'false')
    await expect(mac.locator('[data-remote-group-path="my-sessions"]')).toBeVisible()
    await expect(mac.locator('[data-remote-group-path="Work"] .phone-group-attention')).toHaveText('1 need attention')
    const host = mac.locator(':scope > .phone-group-heading button')
    await host.click()
    await expect(mac.locator('.phone-session')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Linux session/ })).toBeVisible()
    await page.reload()
    await expect(host).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: '1 needs you', exact: true }).click()
    await expect(mac.locator('[data-session-id="parent"]')).toHaveAttribute('data-context-only', 'true')
    await expect(mac.locator('[data-session-id="child"] .phone-status')).toHaveText('Needs decision')
    await expect(mac.locator('[data-session-id="grandchild"]')).toHaveCount(0)
  })

  test('list controls remain touch sized without widening a narrow phone', async ({ page }) => {
    const waiting = session('Decision', 'Work')
    waiting.session.status = 'waiting'; waiting.session.substate = 'interactive-menu'
    await installMenu(page, [group('Work', 1), waiting])
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: '1 needs you', exact: true })).toBeVisible()
    const measure = () => page.evaluate(() => {
      const header = document.querySelector('.phone-sessions .phone-header').getBoundingClientRect()
      const controls = [...document.querySelectorAll('.phone-sessions .phone-header button, .phone-sessions .phone-header input, .phone-filter-menu button')]
        .filter(el => el.getClientRects().length).map(el => Object.assign(el.getBoundingClientRect().toJSON(), { height: el.offsetHeight }))
      return { width: document.documentElement.scrollWidth, viewport: innerWidth, header: header.height,
        heights: controls.filter((_, i, all) => all[i].width > 0).map(r => r.height),
        inside: controls.every(r => r.left >= 0 && r.right <= innerWidth + 0.5) }
    })
    for (const step of [null, 'Filter sessions', 'Search']) {
      if (step === 'Search') await page.keyboard.press('Escape')
      if (step) await page.getByRole('button', { name: step, exact: true }).click()
      await settle(page)
      const dimensions = await measure()
      expect(dimensions.width).toBe(dimensions.viewport)
      expect(dimensions.header).toBe(44)
      expect(dimensions.inside).toBe(true)
      expect(dimensions.heights.filter(h => h < 44), step || 'closed').toEqual(step === 'Search' ? [34] : [])
    }
  })

  test('Running filters both hosts, retains parent context, and resets to All', async ({ page }) => {
    const parent = session('Waiting parent', 'Work')
    parent.session.status = 'waiting'
    await installMenu(page, [group('Work', 2), parent, session('Running child', 'Work', 2, 'Waiting parent'),
      group('Idle', 1), { ...session('Idle session', 'Idle'), session: { ...session('Idle session', 'Idle').session, status: 'idle' } }])
    await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
      { name: 'mac', online: true, sessions: [
        { id: 'r1', title: 'Remote running', group: 'Remote work', status: 'running' },
        { id: 'r2', title: 'Remote waiting', group: 'Remote wait', status: 'waiting' },
      ] },
    ] } }))
    await page.goto('/')
    const filter = page.getByRole('button', { name: 'Filter sessions' })
    const pick = async name => { await filter.click(); await page.getByRole('button', { name, exact: true }).click() }
    await pick('Waiting for input')
    await pick('Running')
    await expect(page.getByRole('group', { name: 'Filter sessions' })).toHaveCount(0)
    await expect(filter).toHaveAttribute('data-active', 'true')
    await filter.click()
    await expect(page.getByRole('button', { name: 'Running', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Waiting for input', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-session-id="Running child"]')).toBeVisible()
    await expect(page.locator('[data-session-id="Waiting parent"]')).toHaveAttribute('data-context-only', 'true')
    await expect(page.getByRole('button', { name: /Remote running/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Remote waiting/ })).toHaveCount(0)
    await expect(page.locator('[data-group-path="Idle"]')).toHaveCount(0)
    await expect(page.locator('[data-remote-group-path="Remote wait"]')).toHaveCount(0)
    await pick('All')
    await expect(filter).not.toHaveAttribute('data-active', 'true')
    await expect(page.locator('[data-session-id="Idle session"]')).toBeVisible()
  })

  test('search expands inline in the header, autofocuses, and closing clears it', async ({ page }) => {
    await installMenu(page, [group('Work', 2), session('Alpha', 'Work'), session('Beta', 'Work')])
    await page.goto('/')
    const header = page.locator('.phone-sessions .phone-header')
    const list = page.locator('.phone-list')
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await settle(page)
    const before = await list.boundingBox()
    await expect(page.getByRole('textbox', { name: 'Search sessions or groups' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'Search sessions or groups' })
    await expect(input).toBeFocused()
    await expect(header.locator('h1')).toHaveCount(0)
    await settle(page)
    expect(await list.boundingBox()).toEqual(before)
    await input.fill('Beta')
    await expect(page.locator('.phone-session')).toHaveCount(1)
    await page.getByRole('button', { name: 'Clear search text' }).click()
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await input.fill('Beta')
    await page.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(header.locator('h1')).toHaveText('Sessions')
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await input.fill('Alpha')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(input).toHaveValue('')
  })

  test('filter popover overlays the list, shows an active dot, and closes on outside tap', async ({ page }) => {
    const idle = session('Idle one', 'Work'); idle.session.status = 'idle'
    await installMenu(page, [group('Work', 2), session('Busy', 'Work'), idle])
    await page.goto('/')
    const filter = page.getByRole('button', { name: 'Filter sessions' })
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await settle(page)
    const list = await page.locator('.phone-list').boundingBox()
    await expect(page.locator('.phone-filter-dot')).toHaveCount(0)
    await filter.click()
    await expect(filter).toHaveAttribute('aria-expanded', 'true')
    const menu = page.getByRole('group', { name: 'Filter sessions' })
    await expect(menu.getByRole('button', { name: 'All', exact: true })).toBeFocused()
    expect(await page.locator('.phone-list').boundingBox()).toEqual(list)
    await page.mouse.click(20, 600)
    await expect(menu).toHaveCount(0)
    await expect(page.locator('.phone-session')).toHaveCount(2)
    await filter.click()
    await menu.getByRole('button', { name: 'Running', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(filter).toBeFocused()
    await expect(page.locator('.phone-filter-dot')).toBeVisible()
    await expect(filter).toHaveAttribute('title', 'Filter: Running')
    await expect(page.locator('.phone-session')).toHaveCount(1)
    await filter.click()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.locator('.phone-filter-dot')).toBeVisible()
  })

  test('attention badge sits in the header, applies the filter, and hides at zero', async ({ page }) => {
    const waiting = session('Asks', 'Work'); waiting.session.status = 'waiting'
    await installMenu(page, [group('Work', 2), waiting, session('Busy', 'Work')])
    await page.goto('/')
    const badge = page.getByRole('button', { name: '1 needs you', exact: true })
    await expect(page.locator('.phone-sessions .phone-header').getByRole('button', { name: '1 needs you' })).toBeVisible()
    await badge.click()
    await expect(badge).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.phone-filter-dot')).toBeVisible()
    await expect(page.locator('.phone-session')).toHaveCount(1)
    await page.getByRole('button', { name: 'Filter sessions' }).click()
    await expect(page.getByRole('button', { name: /Needs attention/ })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')
    await badge.click()
    await expect(page.locator('.phone-session')).toHaveCount(2)

    await installMenu(page, [group('Work', 1), session('Busy', 'Work')])
    await page.reload()
    await expect(page.locator('.phone-session')).toHaveCount(1)
    await expect(page.locator('.phone-attention-filter')).toHaveCount(0)
  })

  test('New session lives in the header and Refresh in More', async ({ page }) => {
    await installMenu(page, [group('Work', 1), session('Busy', 'Work')])
    let menuCalls = 0
    page.on('request', r => { if (new URL(r.url()).pathname === '/api/menu') menuCalls++ })
    await page.goto('/')
    await expect(page.locator('.phone-new')).toHaveCount(0)
    const create = page.locator('.phone-sessions .phone-header').getByRole('button', { name: 'New session', exact: true })
    await expect(create).toBeEnabled()
    await create.click()
    const dialog = page.locator('.dialog', { hasText: /New session/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.locator('.dialog', { hasText: /New session/i })).toHaveCount(0)
    const before = menuCalls
    await page.getByRole('button', { name: 'More', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'More' })
    await expect(sheet).toContainText('Profile:')
    await sheet.getByRole('button', { name: 'Refresh sessions' }).click()
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => menuCalls).toBeGreaterThan(before)
  })
})
