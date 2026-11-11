import { test, expect } from '@playwright/test'

test.describe('phone remote sessions', () => {
  test.skip(({ viewport }) => (viewport?.width || 1280) > 720, 'phone layout only')
  test.use({ serviceWorkers: 'block' })

  test('nests remote paths, persists per-remote collapse, and searches remote name, group, and title', async ({ page, request }) => {
    await request.post('/__fixture/reset')
    await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
      { name: 'mac', online: true, sessions: [
        { id: 'one', title: 'Nested work', group: 'agent-deck/phone', status: 'running' },
        { id: 'two', title: 'Other work', group: 'agent-deck', status: 'waiting' },
        { id: 'root', title: 'Ungrouped work', group: '', status: 'running' },
      ] },
      { name: 'linux', online: true, sessions: [{ id: 'three', title: 'Linux work', group: 'agent-deck', status: 'running' }] },
    ] } }))
    await page.goto('/')
    const mac = page.getByRole('region', { name: 'Remote mac' })
    const linux = page.getByRole('region', { name: 'Remote linux' })
    const parent = mac.locator('[data-remote-group-path="agent-deck"] > .phone-group-heading button')
    await expect(parent).toContainText('2')
    await expect(mac.locator('[data-remote-group-path="agent-deck/phone"]')).toBeVisible()
    await expect(mac.getByRole('button', { name: /Ungrouped work/ })).toBeVisible()
    await parent.click()
    await expect(parent).toHaveAttribute('aria-expanded', 'false')
    await expect(mac.getByRole('button', { name: /Nested work/ })).toHaveCount(0)
    await expect(linux.getByRole('button', { name: /Linux work/ })).toBeVisible()
    await page.reload()
    await expect(parent).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const search = page.getByRole('textbox', { name: 'Search sessions or groups' })
    await search.fill('phone')
    await expect(mac.getByRole('button', { name: /Nested work/ })).toBeVisible()
    await expect(mac.getByRole('button', { name: /Other work/ })).toHaveCount(0)
    await search.fill('mac')
    await expect(mac.getByRole('button', { name: /Other work/ })).toBeVisible()
    await expect(linux.getByRole('button', { name: /Linux work/ })).toHaveCount(0)
    await search.fill('Ungrouped')
    await expect(mac.getByRole('button', { name: /Ungrouped work/ })).toBeVisible()
  })

  test('lists remote status, sends native text, follows delivery, and never attaches Terminal', async ({ page, request }) => {
    await request.post('/__fixture/reset')
    const sockets = [], outputQueries = [], sends = []
    let state = 'queued'
    page.on('websocket', ws => sockets.push(ws.url()))
    await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
      { name: 'oracle', online: true, sessions: [{ id: 'remote-1', title: 'Oracle session', tool: 'codex', status: 'running', group: 'Work' }] },
      { name: 'offline', online: false, stale: true, sessions: [{ id: 'old', title: 'Last known session', status: 'waiting', tool: 'claude' }] },
    ] } }))
    await page.route('**/api/remotes/oracle/sessions/remote-1/output?**', route => {
      outputQueries.push(route.request().url())
      const unchanged = new URL(route.request().url()).searchParams.get('if-version') === 'r1'
      return route.fulfill(unchanged ? { status: 204 } : { json: { content: 'Latest **remote** response', content_version: 'r1', latest_only: true } })
    })
    await page.route('**/api/remotes/oracle/sessions/remote-1/send', route => {
      sends.push(route.request().postDataJSON())
      return route.fulfill({ status: 202, json: { send_id: '01KADJ6QDB0000000000000000', session_id: 'remote-1', state: 'queued' } })
    })
    await page.route('**/api/remotes/oracle/sessions/remote-1/send-status?**', route => route.fulfill({ json: {
      send_id: '01KADJ6QDB0000000000000000', session_id: 'remote-1', state,
    } }))
    await page.goto('/')
    await expect(page.getByRole('region', { name: 'Remote oracle', exact: true })).toContainText('Online')
    await expect(page.getByRole('region', { name: 'Remote offline', exact: true })).toContainText('Offline · Stale')
    await expect(page.getByText('Last known status', { exact: false })).toBeVisible()
    expect(outputQueries).toEqual([])
    await page.getByRole('button', { name: /Oracle session/ }).click()
    await expect(page.getByText('Latest remote response', { exact: true })).toBeVisible()
    await expect(page.getByText(/Latest remote response only/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Terminal/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Session menu', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Session menu' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open Terminal' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    const input = page.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('中文 dictation\nMultiline paste')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText(/session is busy, will send when idle/)).toBeVisible()
    expect(sends).toEqual([{ text: '中文 dictation\nMultiline paste' }])
    state = 'submitted'
    await expect(page.locator('.session-chat-delivery')).toHaveText('submitted', { timeout: 10000 })
    state = 'landed'
    await expect(page.locator('.session-chat-delivery')).toHaveText('landed', { timeout: 10000 })
    expect(outputQueries.some(url => url.includes('if-version=r1'))).toBe(true)
    expect(outputQueries.every(url => url.includes('history=1'))).toBe(true)
    await page.reload()
    await expect(page.getByText('Latest remote response', { exact: true })).toBeVisible()
    expect(sockets).toEqual([])
  })
})

test.describe('phone remote history', () => {
  test.use({ serviceWorkers: 'block' })

test('phone remote history loads earlier messages and polls by cursor', async ({ page, request, viewport }) => {
  test.skip((viewport?.width || 1280) > 720, 'phone layout only')
  await request.post('/__fixture/reset')
  const queries = []
  await page.route('**/api/remotes', route => route.fulfill({ json: { remotes: [
    { name: 'mac', online: true, sessions: [{ id: 'history', title: 'Remote history', tool: 'pi', status: 'waiting' }] },
  ] } }))
  await page.route('**/api/remotes/mac/sessions/history/output?**', route => {
    const q = new URL(route.request().url()).searchParams
    queries.push(Object.fromEntries(q))
    if (q.get('before') === 'older') return route.fulfill({ json: {
      messages: [{ id: 'old-user', role: 'user', content: 'Earlier question' }, { id: 'old-reply', role: 'assistant', content: 'Earlier answer' }], has_more: false,
    } })
    if (q.has('since')) return route.fulfill({ status: 204 })
    return route.fulfill({ json: {
      messages: [{ id: 'new-user', role: 'user', content: 'Recent question' }, { id: 'new-reply', role: 'assistant', content: 'Recent answer' }],
      before_cursor: 'older', through_cursor: 'current', content_version: 'v1', has_more: true,
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /Remote history/ }).click()
  await expect(page.getByText('Recent answer', { exact: true })).toBeVisible()
  await expect(page.getByText(/Latest remote response only/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Load earlier' }).click()
  await expect(page.getByText('Earlier question', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load earlier' })).toHaveCount(0)
  await expect(page.locator('[data-message-id]')).toHaveCount(4)
  expect(await page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => n.dataset.messageId))).toEqual(['old-user', 'old-reply', 'new-user', 'new-reply'])
  await expect.poll(() => queries.some(q => q.since === 'current' && q['if-version'] === 'v1'), { timeout: 10000 }).toBe(true)
  expect(queries.every(q => q.history === '1')).toBe(true)
})
})
