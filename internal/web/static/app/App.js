// App.js -- Root Preact component (app shell)
// Phase 3: full-page layout with responsive sidebar.
// Phase 6: adds popstate route sync and URL push on selection change.
// Task 11: /g/{path} gives a selected group the same URL parity as a
// selected session (/s/{id}); applyPath is shared by popstate (here) and
// cold boot (main.js's applyRouteSelection) so the two paths cannot drift.
import { html } from 'htm/preact'
import { useEffect, useLayoutEffect } from 'preact/hooks'
import { phoneViewportSignal, phoneShellSignal, observePhoneViewport, useDesktopLayout } from './phoneLayout.js'
import { useLazyComponent } from './lazyModule.js'
import { AppShell } from './AppShell.js'
import { selectedIdSignal, selectedGroupSignal, selectSession, selectGroup } from './state.js'
import { activeTabSignal } from './uiState.js'
import { PANES } from './paneRegistry.js'

// Map a pathname onto the selection. encodeURIComponent turns a nested group
// path ("work/innotrade") into "work%2Finnotrade", which keeps the no-slash
// guard below meaningful for both routes.
// A URL-driven selection must SHOW what it selected without overruling a pane
// the viewer chose. Groups need no tab handling — Panes renders the group panel
// over whatever tab is active. Sessions live in the terminal pane, which is
// hidden unless the tab is 'terminal'. A /s/{id} link must leave global panes
// such as Fleet, but preserve session-scoped panes such as Skills (PR #2047).
// Inspect the current pane for both cold loads and browser history navigation.
// Not done in selectSession/selectGroup — j/k call
// those and must not switch tabs, or xterm eats the next key (issue #780).
export function applyPath(path) {
  if (path.startsWith('/s/')) {
    const raw = path.slice(3)
    if (raw && !raw.includes('/')) {
      try {
        selectSession(decodeURIComponent(raw))
        const tab = activeTabSignal.value
        if (typeof tab !== 'string' || !PANES[tab]?.sessionScoped) {
          activeTabSignal.value = 'terminal'
        }
      } catch (_) { selectSession(null) }
      return
    }
  }
  if (path.startsWith('/g/')) {
    const raw = path.slice(3)
    if (raw && !raw.includes('/')) {
      try { selectGroup(decodeURIComponent(raw)) } catch (_) { selectSession(null) }
      return
    }
  }
  // Clearing on popstate to / lets the empty dashboard render when the user
  // navigates back.
  if (path === '/') selectSession(null)
}

export function App() {
  useEffect(observePhoneViewport, [])
  const phone = phoneShellSignal.value
  useLayoutEffect(() => {
    const root = document.getElementById('app-root')
    root?.classList.toggle('phone-root', phone)
    if (!phone && selectedIdSignal.value?.startsWith('remote:')) selectSession(null)
    return () => root?.classList.remove('phone-root')
  }, [phone])
  const PhoneShell = useLazyComponent(phone, () => import('./PhoneShell.js'), 'phoneShell', m => m.PhoneShell)
  // Route sync: update the selection when the browser navigates back/forward.
  useEffect(() => {
    function onPopState() {
      applyPath(window.location.pathname || '/')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // URL push: write the URL when the selection changes.
  useEffect(() => {
    const id = selectedIdSignal.value
    const groupPath = selectedGroupSignal.value
    let targetPath = '/'
    if (id) targetPath = '/s/' + encodeURIComponent(id)
    else if (groupPath) targetPath = '/g/' + encodeURIComponent(groupPath)
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, '', targetPath)
    }
  }, [selectedIdSignal.value, selectedGroupSignal.value])

  return html`
    ${phone ? PhoneShell ? html`<${PhoneShell}/>` : html`<p role="status">Loading sessions…</p>` : html`<${AppShell}/>`}
    ${phoneViewportSignal.value && !phone && html`<button class="phone-return" onClick=${() => useDesktopLayout(false)}>Phone layout</button>`}
  `
}
