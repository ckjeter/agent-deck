// swUpdate.js -- An installed iOS web app rarely navigates, so it keeps running
// old code after a deploy. Check for a new worker whenever the app comes back to
// the foreground. A deploy is recognised by a shell cache name (sw.js
// CACHE_VERSION) that did not exist when this page booted; controllerchange
// alone also fires without any new code, and a first install is not an update. Reload at once if the app was opened or
// resumed in the last few seconds, else on the next resume, so a reload never
// lands in the middle of use.
export const FRESH_WINDOW_MS = 5000
const SHELL_PREFIX = 'agentdeck-shell-'

export function watchServiceWorkerUpdates({ container, doc, reload, cacheKeys, now = Date.now }) {
  const shellKeys = () => Promise.resolve(cacheKeys()).then(keys => keys.filter(k => k.startsWith(SHELL_PREFIX)))
  const booted = shellKeys().catch(() => null)
  let visibleSince = doc.visibilityState === 'visible' ? now() : null
  let pending = false
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') { visibleSince = null; return }
    visibleSince = now()
    if (pending) { reload(); return }
    Promise.resolve(container.getRegistration?.('/'))
      .then(reg => reg?.update())
      .catch(() => {})
  })
  container.addEventListener('controllerchange', async () => {
    if (pending) return
    const before = await booted
    if (!before?.length) return
    let current
    try { current = await shellKeys() } catch { return }
    if (!current.some(k => !before.includes(k)) || pending) return
    if (visibleSince !== null && now() - visibleSince < FRESH_WINDOW_MS) reload()
    else pending = true
  })
}
