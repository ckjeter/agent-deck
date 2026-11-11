// PhoneSessionActions.js -- Phone sheets for the everyday session actions:
// Rename, Move to group, Archive, Delete (with Undo), and the Archived list
// with Restore. They call the same routes as the desktop Sidebar,
// EditSessionDialog and ArchivedPane, so a change made here means the same
// thing in every client.
import { html } from 'htm/preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { menuModelSignal } from './dataModel.js'
import { archivedSessionsSignal, loadArchivedSessions } from './state.js'
import { projectArchived } from './panes/ArchivedPane.js'
import { apiFetch } from './api.js'
import { addToast } from './toasts.js'

// menudata.DefaultUndoWindow. The web mutator always uses it (only tests
// override it), and the server is what enforces it.
export const UNDO_WINDOW_MS = 30000
export const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP_PX = 10
const DEFAULT_GROUP_PATH = 'my-sessions'

// actionBlocker returns why the session mutations are unavailable, or ''.
export function actionBlocker(settings, remote) {
  if (remote) return `Sessions on ${remote} can only be renamed, moved, archived or deleted on that machine.`
  if (!settings) return 'Loading server settings…'
  if (settings.readOnly) return 'This server is read-only. Session changes are turned off.'
  if (settings.webMutations === false) return 'Web changes are turned off on this server.'
  return ''
}

// createLongPress drives the row long-press. One controller serves every row
// (only one finger press is live at a time). The timer is cancelled by any
// movement past the slop, by pointercancel (the browser takes the touch over
// for scrolling) and by release, so neither a scroll nor a tap opens the
// sheet. A press that did fire swallows the click that follows it.
export function createLongPress(onLongPress, { delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP_PX } = {}) {
  let timer = null, start = null, firedKey = null
  const cancel = () => { clearTimeout(timer); timer = null; start = null }
  return {
    bind(key, target) {
      return {
        onPointerDown: e => {
          firedKey = null
          cancel()
          if (e.button > 0) return
          start = { x: e.clientX, y: e.clientY }
          timer = setTimeout(() => { timer = null; start = null; firedKey = key; onLongPress(target) }, delay)
        },
        onPointerMove: e => {
          if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) cancel()
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onPointerLeave: cancel,
        // Android raises contextmenu for a held finger and desktop for a right
        // click; the ContextMenu key raises it without a press. Only a
        // pointer press arms the click swallow.
        onContextMenu: e => {
          e.preventDefault()
          if (firedKey === key && !start) return
          const fromPress = !!start
          cancel()
          if (fromPress) firedKey = key
          onLongPress(target)
        },
      }
    },
    consumeClick(key) {
      if (firedKey !== key) return false
      firedKey = null
      return true
    },
    cancel,
  }
}

function trapTab(e) {
  if (e.key !== 'Tab') return
  const items = [...e.currentTarget.querySelectorAll('button:not([disabled]), input:not([disabled])')]
  if (!items.length) return
  const first = items[0], last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
}

// Sheet is the shared bottom-sheet frame: backdrop, focus on open, Escape,
// Tab trap, and focus back to the opener on close. A backdrop tap within
// the first 400ms is ignored so the finger lifting off a long press does not
// dismiss the sheet it just opened.
function Sheet({ label, onClose, children, busy, focusKey, focusInput = true }) {
  const ref = useRef(null)
  const openedAt = useRef(Date.now())
  useEffect(() => {
    const opener = document.activeElement
    return () => opener?.focus?.()
  }, [])
  useEffect(() => {
    const root = ref.current
    ;((focusInput && root?.querySelector('input:not([disabled])')) || root?.querySelector('button:not([disabled])'))?.focus()
  }, [focusKey])
  const dismiss = () => { if (!busy) onClose() }
  return html`<div class="phone-sheet-backdrop phone-action-backdrop"
      onClick=${() => { if (Date.now() - openedAt.current > 400) dismiss() }}>
    <section ref=${ref} role="dialog" aria-modal="true" aria-label=${label} class="phone-sheet phone-action-sheet"
      onClick=${e => e.stopPropagation()}
      onKeyDown=${e => { if (e.key === 'Escape') dismiss(); trapTab(e) }}>
      ${children}
    </section>
  </div>`
}

function moveTargets(groups, current) {
  const out = groups.map(g => ({ path: g.path, name: g.name || g.path, depth: g.depth || 0 }))
  if (!out.some(g => g.path === DEFAULT_GROUP_PATH)) out.unshift({ path: DEFAULT_GROUP_PATH, name: 'My Sessions', depth: 0 })
  return out.map(g => ({ ...g, current: g.path === (current || DEFAULT_GROUP_PATH) }))
}

function isProcessLive(status) {
  return !['stopped', 'error', ''].includes(status || '')
}

// PhoneSessionSheet: target is { id, title, group, tool, status, remote }.
// onDone(kind) runs after a successful mutation; kind is 'rename', 'move',
// 'archive' or 'delete' so the shell can leave a conversation that is gone.
export function PhoneSessionSheet({ target, settings, initialView = 'menu', onClose, onDone }) {
  const [view, setView] = useState(initialView)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [title, setTitle] = useState(target.title || '')
  const [newGroup, setNewGroup] = useState(null)
  const [moved, setMoved] = useState(null)
  const blocker = actionBlocker(settings, target.remote)
  const sessionPath = '/api/sessions/' + encodeURIComponent(target.id)
  const go = next => { setError(''); setView(next) }

  const run = async (kind, fn) => {
    setPending(kind); setError('')
    try { await fn() }
    catch (e) { setError(e.message || String(e)); setPending('') }
  }

  const rename = e => {
    e?.preventDefault()
    if (pending) return
    if (title === target.title) { onClose(); return }
    run('rename', async () => {
      await apiFetch('PATCH', sessionPath, { title }, { toast: false })
      onClose(); onDone?.('rename')
      addToast(`Renamed to “${title.trim()}”`, 'success')
    })
  }

  const move = path => run('move:' + path, async () => {
    const res = await apiFetch('POST', sessionPath + '/move', { groupPath: path }, { toast: false })
    onDone?.('move')
    if (res?.restartRequired) { setPending(''); setMoved(res.groupPath || path); setView('moved'); return }
    onClose()
    addToast(`Moved “${target.title}” to ${res?.groupPath || path}`, 'success')
  })

  const archive = () => run('archive', async () => {
    await apiFetch('POST', sessionPath + '/archive', undefined, { toast: false })
    onClose(); onDone?.('archive')
    addToast(`Archived “${target.title}”. Restore it from More, Archived.`, 'success')
  })

  const remove = () => run('delete', async () => {
    const started = Date.now()
    await apiFetch('DELETE', sessionPath, undefined, { toast: false })
    onClose(); onDone?.('delete')
    const remaining = Math.max(0, UNDO_WINDOW_MS - (Date.now() - started) - 500)
    addToast(`Deleted “${target.title}”`, 'info', {
      timeoutMs: remaining,
      action: { label: 'Undo', onClick: () => undoDelete(target) },
    })
  })

  const meta = [target.remote, target.group, target.tool].filter(Boolean).join(' · ')
  const header = (heading, back = true) => html`<header>
    ${back && initialView === 'menu' && view !== 'menu'
      ? html`<button type="button" class="phone-sheet-back" disabled=${!!pending} onClick=${() => go('menu')} aria-label="Back to actions">‹</button>` : null}
    <h2>${heading}</h2>
  </header>`
  const errorLine = error && html`<p class="phone-action-error" role="alert">${error}</p>`
  const cancel = html`<button type="button" class="phone-action-cancel" disabled=${!!pending} onClick=${onClose}>Cancel</button>`

  let body
  if (view === 'rename') {
    body = html`${header('Rename session')}
      <form class="phone-action-form" onSubmit=${rename}>
        <input aria-label="Session title" value=${title} maxLength="200" enterKeyHint="done" autocomplete="off"
          aria-invalid=${error ? 'true' : undefined} disabled=${!!pending}
          onInput=${e => { setTitle(e.target.value); setError('') }}/>
        ${errorLine}
        <div class="phone-action-row">${cancel}
          <button type="submit" class="phone-action-primary" disabled=${!!pending}>${pending ? 'Saving…' : 'Save'}</button></div>
      </form>`
  } else if (view === 'move') {
    const targets = moveTargets(menuModelSignal.value.groups, target.group)
    body = html`${header('Move to group')}
      <p class="phone-action-meta">${target.title}</p>
      <ul class="phone-move-list" role="list">
        ${targets.map(g => html`<li key=${g.path}>
          <button type="button" style=${{ '--group-depth': g.depth }} aria-current=${g.current ? 'true' : undefined}
            disabled=${g.current || !!pending} onClick=${() => move(g.path)}>
            <span>${g.name}</span>
            <small>${g.current ? 'Current' : pending === 'move:' + g.path ? 'Moving…' : ''}</small>
          </button></li>`)}
      </ul>
      ${newGroup === null
        ? html`<button type="button" class="phone-move-new" disabled=${!!pending} onClick=${() => setNewGroup('')}>New group…</button>`
        : html`<form class="phone-action-form" onSubmit=${e => { e.preventDefault(); if (newGroup.trim() && !pending) move(newGroup.trim()) }}>
            <input aria-label="New group name" placeholder="New group name" value=${newGroup} enterKeyHint="done" autocomplete="off"
              disabled=${!!pending} onInput=${e => { setNewGroup(e.target.value); setError('') }}/>
            <button type="submit" class="phone-action-primary" disabled=${!newGroup.trim() || !!pending}>
              ${pending === 'move:' + newGroup.trim() ? 'Moving…' : 'Create group and move'}</button>
          </form>`}
      ${errorLine}
      ${cancel}`
  } else if (view === 'moved') {
    body = html`${header('Moved', false)}
      <p role="status">Moved “${target.title}” to ${moved}. Restart the session to use the new group's Claude config directory. Until then it keeps the old one.</p>
      <button type="button" class="phone-action-primary" onClick=${onClose}>Done</button>`
  } else if (view === 'archive') {
    body = html`${header('Archive session?')}
      <p><strong>${target.title}</strong> leaves the active list. ${isProcessLive(target.status)
        ? 'Its process will be stopped.' : 'It is already stopped.'} Restore it any time from More, Archived. Restoring does not restart it.</p>
      ${errorLine}
      <div class="phone-action-row">${cancel}
        <button type="button" class="phone-action-warn" disabled=${!!pending} onClick=${archive}>${pending ? 'Archiving…' : 'Archive'}</button></div>`
  } else if (view === 'delete') {
    body = html`${header('Delete session?')}
      <p><strong>${target.title}</strong> will be deleted everywhere: on this phone, in the desktop web UI and in the TUI. Its process is stopped and its metadata removed.</p>
      <p>You can undo for ${UNDO_WINDOW_MS / 1000} seconds.</p>
      ${errorLine}
      <div class="phone-action-row">${cancel}
        <button type="button" class="phone-action-danger" disabled=${!!pending} onClick=${remove}>${pending ? 'Deleting…' : 'Delete'}</button></div>`
  } else {
    body = html`<header><h2>${target.title}</h2></header>
      ${meta && html`<p class="phone-action-meta">${meta}</p>`}
      ${blocker && html`<p class="phone-action-reason" role="note">${blocker}</p>`}
      <div class="phone-action-list">
        <button type="button" disabled=${!!blocker} onClick=${() => go('rename')}>Rename</button>
        <button type="button" disabled=${!!blocker} onClick=${() => go('move')}>Move to group</button>
        <button type="button" disabled=${!!blocker} onClick=${() => go('archive')}>Archive</button>
        <button type="button" class="phone-action-danger" disabled=${!!blocker} onClick=${() => go('delete')}>Delete</button>
      </div>
      <button type="button" class="phone-action-cancel" onClick=${onClose}>Cancel</button>`
  }
  return html`<${Sheet} label=${'Actions for ' + target.title} onClose=${onClose} busy=${!!pending} focusKey=${view}>${body}</${Sheet}>`
}

// undoDelete calls the server's single undo slot, which restores the most
// recent web deletion still inside its window. Say which session came back
// rather than assume it was this one.
export async function undoDelete(target) {
  try {
    const res = await apiFetch('POST', '/api/sessions/undelete', undefined, { toast: false })
    if (!res?.sessionId || res.sessionId === target.id) addToast(`Restored “${target.title}”`, 'success')
    else addToast(`Restored the most recent deletion (${res.sessionId})`, 'success')
  } catch (e) {
    addToast(/expired|nothing/i.test(e.message) ? 'Undo window has passed' : 'Undo failed: ' + e.message, 'info')
  }
}

function formatArchivedAt(iso) {
  const d = iso ? new Date(iso) : null
  return d && d.getUTCFullYear() > 1 ? d.toLocaleDateString(undefined, { dateStyle: 'medium' }) : ''
}

// PhoneArchivedSheet lists archived local sessions with Restore. Restore only
// clears the archive flag. The session stays stopped (UnarchiveSession never
// starts tmux).
export function PhoneArchivedSheet({ settings, onClose, onRestored }) {
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState('')
  const blocker = actionBlocker(settings, null)
  useEffect(() => { loadArchivedSessions().finally(() => setLoaded(true)) }, [])
  const needle = filter.trim().toLowerCase()
  const rows = (archivedSessionsSignal.value || []).map(projectArchived)
    .filter(s => !needle || `${s.title} ${s.group} ${s.tool} ${s.path}`.toLowerCase().includes(needle))
  const restore = async s => {
    setPending(s.id); setError(''); setNotice('')
    try {
      await apiFetch('POST', '/api/sessions/' + encodeURIComponent(s.id) + '/unarchive', undefined, { toast: false })
      await loadArchivedSessions()
      onRestored?.()
      setNotice(`Restored “${s.title}”. It stays stopped until you start it.`)
    } catch (e) { setError(`${s.title}: ${e.message}`) }
    finally { setPending('') }
  }
  return html`<${Sheet} label="Archived sessions" onClose=${onClose} busy=${false} focusInput=${false}>
    <header><h2>Archived</h2><button type="button" onClick=${onClose}>Done</button></header>
    ${blocker && html`<p class="phone-action-reason" role="note">${blocker}</p>`}
    <input class="phone-archived-filter" aria-label="Filter archived sessions" placeholder="Filter archived" value=${filter}
      onInput=${e => setFilter(e.target.value)}/>
    ${errorLineFor(error)}
    ${notice && html`<p class="phone-action-notice" role="status">${notice}</p>`}
    ${!loaded && html`<p>Loading archived sessions…</p>`}
    ${loaded && !rows.length && html`<p>${needle ? 'No matches.' : 'No archived sessions.'}</p>`}
    <ul class="phone-archived-list" role="list">
      ${rows.map(s => html`<li key=${s.id} class="phone-archived-row">
        <span><strong>${s.title}</strong>
          <small>${[s.group, s.tool, formatArchivedAt(s.archivedAt) && 'Archived ' + formatArchivedAt(s.archivedAt)].filter(Boolean).join(' · ')}</small></span>
        <button type="button" aria-label=${'Restore ' + s.title} disabled=${!!blocker || !!pending} onClick=${() => restore(s)}>
          ${pending === s.id ? 'Restoring…' : 'Restore'}</button>
      </li>`)}
    </ul>
  </${Sheet}>`
}

function errorLineFor(error) {
  return error ? html`<p class="phone-action-error" role="alert">${error}</p>` : null
}
