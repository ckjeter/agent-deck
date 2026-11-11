import { html } from 'htm/preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { sessionsSignal, sessionsLoadedSignal, selectedIdSignal, selectedGroupSignal, selectSession,
  connectionSignal, settingsSignal, mutationsEnabledSignal, readOnlySignal,
  createSessionDialogSignal, pickerToolsSignal, modelCatalogSignal, trustedDomainsSignal, confirmLinkOpenSignal, fileLinkRootsSignal, fileLinkHostSignal } from './state.js'
import { menuModelSignal, toggleGroupOpen, isGroupOpen, isGroupVisible, parentGroupPath,
  openCreateSessionForGroup } from './dataModel.js'
import { groupExpandedSignal, profileSignal } from './uiState.js'
import { apiFetch, authHeaders } from './api.js'
import { useDesktopLayout } from './phoneLayout.js'
import { useLazyComponent } from './lazyModule.js'
import { installViewportInsets } from './viewportInsets.js'
import { SessionChat } from './SessionChat.js'
import { ToastContainer } from './Toast.js'
import { ATTENTION_LABELS, attentionCount, sessionAttention } from './sessionAttention.js'
import { localSessionRows, remoteSessionRows, remoteGroups } from './phoneSessionTree.js'
import { loadPhoneDraft, savePhoneDraft, cleanPhoneDrafts } from './phoneDrafts.js'
import { PhoneSessionSheet, PhoneArchivedSheet, actionBlocker, createLongPress } from './PhoneSessionActions.js'

function openedLabel(value) {
  const date = new Date(value)
  return date.getUTCFullYear() > 1 ? ' · Opened ' + date.toLocaleDateString() : ''
}

function statusMarker(session) {
  const attention = sessionAttention(session)
  const detail = session.substateDetail || session.substate_detail || session.raw?.substateDetail || ''
  return html`<span class="phone-status" data-state=${session.status} data-attention=${attention || undefined}
    aria-label=${attention ? ATTENTION_LABELS[attention] : undefined} title=${detail || undefined}>
    ${attention ? ATTENTION_LABELS[attention] : session.status}
  </span>`
}

const ICONS = {
  search: html`<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>`,
  filter: html`<path d="M4 6h16M7 12h10M10 18h4"/>`,
  plus: html`<path d="M12 5v14M5 12h14"/>`,
  more: html`<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>`,
}
const icon = name => html`<svg class="phone-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`
const FILTER_LABELS = { all: 'All', running: 'Running', waiting: 'Waiting for input', attention: 'Needs attention' }

function attentionBadge(count) {
  if (!count) return null
  return html`<span class="phone-group-attention" aria-label=${count === 1 ? '1 session needs attention' : count + ' sessions need attention'}>${count} need attention</span>`
}

export function PhoneShell() {
  const { groups, sessions, byGroup } = menuModelSignal.value
  const id = selectedIdSignal.value
  const groupPath = selectedGroupSignal.value
  const connection = connectionSignal.value
  const settings = settingsSignal.value
  const profile = settings?.profile || ''
  const [search, setSearch] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [running, setRunning] = useState(false)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [more, setMore] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [offline, setOffline] = useState(false)
  const searchInput = useRef(null)
  const filterButton = useRef(null)
  const [terminalID, setTerminalID] = useState(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [remotes, setRemotes] = useState([])
  const [remoteError, setRemoteError] = useState('')
  const [remoteExpanded, setRemoteExpanded] = useState({})
  const [actionSheet, setActionSheet] = useState(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const press = useRef(null)
  if (!press.current) press.current = createLongPress(target => setActionSheet({ target, view: 'menu' }))
  const openedHere = useRef(false)
  const focusedGroup = useRef(null)
  const touchStart = useRef(null)
  const list = useRef(null)
  const closeButton = useRef(null)
  const opener = useRef(null)
  const remoteSelection = remotes.flatMap(remote => (remote.sessions || []).map(s => ({
    remote, session: s, key: 'remote:' + encodeURIComponent(remote.name) + ':' + encodeURIComponent(s.id),
  }))).find(s => s.key === id)
  const isRemote = !!id?.startsWith('remote:')
  const selected = remoteSelection ? { ...remoteSelection.session, group: remoteSelection.remote.name } : sessions.find(s => s.id === id)
  const selectedAttention = sessionAttention(selected)
  const selectedDetail = selected?.substateDetail || selected?.substate_detail || selected?.raw?.substateDetail || ''
  const canMutate = !!settings && settings.webMutations && !settings.readOnly
  const Create = useLazyComponent(!!createSessionDialogSignal.value, () => import('./CreateSessionDialog.js'), 'createDialog', m => m.CreateSessionDialog)
  const Terminal = useLazyComponent(!isRemote && terminalID === id && !!id, () => import('./TerminalPanel.js'), 'phoneTerminal', m => m.TerminalPanel)
  const raw = new Map(sessionsSignal.value.filter(i => i.session).map(i => [i.session.id, i.session]))
  const refreshRemotes = async () => {
    const data = await apiFetch('GET', '/api/remotes')
    setRemotes(data.remotes || []); setRemoteError('')
  }

  const refresh = async () => {
    setRefreshing(true); setError('')
    try {
      const data = await apiFetch('GET', '/api/menu')
      sessionsSignal.value = data.items || []
      sessionsLoadedSignal.value = true
      await refreshRemotes()
    } catch (e) { setError(e.message) }
    finally { setRefreshing(false) }
  }

  useEffect(() => {
    const controller = new AbortController()
    let timer
    const poll = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch('/api/remotes', { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
          const data = await res.json()
          if (!res.ok) throw new Error(data?.error?.message || 'Unable to read remotes')
          if (!controller.signal.aborted) { setRemotes(data.remotes || []); setRemoteError('') }
        } catch (e) { if (!controller.signal.aborted) setRemoteError(e.message) }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
    }
    poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    installViewportInsets(window, document.documentElement, controller.signal)
    let alive = true
    const loadSettings = () => apiFetch('GET', '/api/settings').then(data => {
      if (!alive) return
      settingsSignal.value = data
      mutationsEnabledSignal.value = data.webMutations && !data.readOnly
      readOnlySignal.value = !!data.readOnly
      profileSignal.value = data.profile
      if (data.pickerTools?.length) pickerToolsSignal.value = data.pickerTools
      if (data.modelCatalog) modelCatalogSignal.value = data.modelCatalog
      if (Array.isArray(data.trustedDomains)) trustedDomainsSignal.value = data.trustedDomains
      if (typeof data.confirmLinkOpen === 'boolean') confirmLinkOpenSignal.value = data.confirmLinkOpen
      if (Array.isArray(data.fileLinkRoots)) fileLinkRootsSignal.value = data.fileLinkRoots
      if (typeof data.fileLinkHost === 'string') fileLinkHostSignal.value = data.fileLinkHost
    }).catch(e => { if (alive) setError(e.message) })
    loadSettings()
    const resume = () => { if (!document.hidden) { refresh(); loadSettings() } }
    window.addEventListener('online', resume, { signal: controller.signal })
    document.addEventListener('visibilitychange', resume, { signal: controller.signal })
    return () => { alive = false; controller.abort() }
  }, [])

  useEffect(() => {
    if (!groupPath) { focusedGroup.current = null; return }
    if (focusedGroup.current === groupPath || !groups.some(g => g.path === groupPath)) return
    for (let path = parentGroupPath(groupPath); path; path = parentGroupPath(path)) {
      if (!isGroupOpen(groupExpandedSignal.value, path)) toggleGroupOpen(path)
    }
    const frame = requestAnimationFrame(() => {
      focusedGroup.current = groupPath
      Array.from(list.current?.querySelectorAll('[data-group-path]') || []).find(el => el.dataset.groupPath === groupPath)?.scrollIntoView?.({ block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [groupPath, groups])

  useEffect(() => { setTerminalID(null) }, [id])

  useEffect(() => {
    if (profile && sessionsLoadedSignal.value && connection === 'connected') cleanPhoneDrafts(profile, [...raw.keys()])
  }, [profile, sessionsSignal.value, sessionsLoadedSignal.value, connection])

  useEffect(() => {
    if (!profile) return
    for (const remote of remotes) {
      if (!remote.online || remote.stale || !Array.isArray(remote.sessions)) continue
      const prefix = 'remote:' + encodeURIComponent(remote.name) + ':'
      cleanPhoneDrafts(profile, remote.sessions.map(s => prefix + encodeURIComponent(s.id)), Date.now(), id => id.startsWith(prefix))
    }
  }, [profile, remotes])

  useEffect(() => {
    if (!more) return
    opener.current = document.activeElement
    closeButton.current?.focus()
    return () => opener.current?.focus()
  }, [more])

  useEffect(() => {
    if (connection !== 'disconnected') { setOffline(false); return }
    const timer = setTimeout(() => setOffline(true), 2000)
    return () => clearTimeout(timer)
  }, [connection])

  useEffect(() => { if (searchOpen && !id) searchInput.current?.focus() }, [searchOpen])

  useLayoutEffect(() => {
    if (!filterOpen) return
    document.querySelector('.phone-filter-menu [data-autofocus]')?.focus()
    const onKey = e => { if (e.key === 'Escape') { setFilterOpen(false); filterButton.current?.focus() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [filterOpen])

  const filterKey = attentionOnly ? 'attention' : running ? 'running' : waiting ? 'waiting' : 'all'
  const filterActive = filterKey !== 'all'
  const filterLabel = FILTER_LABELS[filterKey]
  const applyFilter = key => {
    setRunning(key === 'running'); setWaiting(key === 'waiting'); setAttentionOnly(key === 'attention')
    if (filterOpen) { setFilterOpen(false); filterButton.current?.focus() }
  }
  const closeSearch = () => { setSearch(''); setSearchOpen(false) }

  const open = session => {
    openedHere.current = true
    setTerminalID(null)
    selectSession(session.id)
  }
  const back = () => {
    setTerminalID(null)
    if (openedHere.current) window.history.back()
    else { window.history.replaceState(null, '', '/'); selectSession(null) }
  }
  const localTarget = s => ({ id: s.id, title: s.title, group: s.group, tool: s.tool, status: s.status })
  const remoteTarget = (remote, s) => ({ id: s.id, title: s.title || s.id, group: s.group, tool: s.tool, status: s.status, remote: remote.name })
  const selectedTarget = !id ? null : remoteSelection ? remoteTarget(remoteSelection.remote, remoteSelection.session) : selected ? localTarget(selected) : null
  const actionDone = (kind, target) => {
    refresh()
    if ((kind === 'archive' || kind === 'delete') && !target.remote && selectedIdSignal.value === target.id) back()
  }
  const openAction = view => { setMore(false); setActionSheet({ target: selectedTarget, view }) }
  const sessionBlocker = selectedTarget ? actionBlocker(settings, selectedTarget.remote) : ''
  const overlay = more || !!actionSheet || archivedOpen
  const needle = search.trim().toLowerCase()
  const matches = s => (!waiting || s.status === 'waiting') && (!running || s.status === 'running') && (!attentionOnly || sessionAttention(s)) &&
    (!needle || `${s.title} ${s.group} ${s.path} ${raw.get(s.id)?.latestPrompt || ''}`.toLowerCase().includes(needle))
  const remoteMatches = (remote, s) => !s.archived && (!waiting || s.status === 'waiting') && (!running || s.status === 'running') && (!attentionOnly || sessionAttention(s)) &&
    (!needle || `${remote.name} ${s.group || ''} ${s.title || ''}`.toLowerCase().includes(needle))
  const remoteGroupKey = (remote, path) => 'agentdeck.phone.remoteGroup.' + encodeURIComponent(remote) + '/' + encodeURIComponent(path)
  const remoteGroupOpen = (remote, path) => {
    const key = remoteGroupKey(remote, path)
    return (remoteExpanded[key] ?? localStorage.getItem(key)) !== 'false'
  }
  const toggleRemoteGroup = (remote, path) => {
    const key = remoteGroupKey(remote, path)
    const expanded = !remoteGroupOpen(remote, path)
    localStorage.setItem(key, String(expanded))
    setRemoteExpanded(current => ({ ...current, [key]: String(expanded) }))
  }
  const remoteGroupVisible = (remote, path) => {
    for (let parent = parentGroupPath(path); parent; parent = parentGroupPath(parent)) {
      if (!remoteGroupOpen(remote, parent)) return false
    }
    return true
  }
  const remoteGroupMatches = (remote, group, allSessions) => allSessions.some(s =>
    (s.group === group.path || s.group?.startsWith(group.path + '/')) && remoteMatches(remote, s))
  const remoteRow = (remote, row) => {
    const s = row.session
    const rowKey = 'remote:' + encodeURIComponent(remote.name) + ':' + encodeURIComponent(s.id)
    return html`
    <button type="button" class="phone-session" data-session-id=${s.id} data-session-depth=${row.depth} data-nested=${row.nested} data-last-child=${row.lastChild} data-context-only=${row.contextOnly} key=${s.id}
      ...${press.current.bind(rowKey, remoteTarget(remote, s))} onClick=${() => { if (!press.current.consumeClick(rowKey)) open({ id: rowKey }) }}>
      <span class="phone-session-top"><strong>${s.title}</strong>${statusMarker(s)}</span>
      <span class="phone-session-meta">${s.tool}${row.contextOnly ? ' · Parent context' : ''}${!remote.online || remote.stale ? ' · Last known status' : ''}</span>
    </button>`
  }
  const localRow = row => {
    const s = row.session
    const prompt = raw.get(s.id)?.latestPrompt
    return html`<button type="button" class="phone-session" data-session-id=${s.id} data-session-depth=${row.depth} data-nested=${row.nested} data-last-child=${row.lastChild} data-context-only=${row.contextOnly} key=${s.id}
      ...${press.current.bind(s.id, localTarget(s))} onClick=${() => { if (!press.current.consumeClick(s.id)) open(s) }}>
      <span class="phone-session-top"><strong>${s.title}</strong>${statusMarker(s)}</span>
      <span class="phone-session-meta" title=${s.tool + openedLabel(raw.get(s.id)?.lastAccessedAt)}>
        <span class="phone-session-tool">${s.tool}${row.contextOnly ? ' · Parent context' : ''}${prompt ? ' · ' : openedLabel(raw.get(s.id)?.lastAccessedAt)}</span>
        ${prompt && html`<span class="phone-preview">Prompt: ${prompt.split(/\r?\n/)[0]}</span>`}
      </span>
    </button>`
  }
  const visible = sessions.filter(matches)
  const filtering = !!needle || waiting || running || attentionOnly
  const rows = group => localSessionRows(byGroup[group.path] || [], group.depth, matches)
  const groupMatches = group => visible.some(s => s.group === group.path || s.group.startsWith(group.path + '/')) ||
    (!waiting && !running && !attentionOnly && (!needle || `${group.name} ${group.path}`.toLowerCase().includes(needle)))
  const totalAttention = sessions.filter(s => sessionAttention(s)).length + remotes.reduce((count, remote) =>
    count + (remote.sessions || []).filter(s => !s.archived && sessionAttention(s)).length, 0)

  return html`
    <div class=${'phone-shell' + (id ? '' : ' phone-sessions-screen')} data-testid="phone-shell">
      <div class="phone-screen" inert=${overlay ? true : undefined} aria-hidden=${overlay ? 'true' : undefined}>
        ${id && html`<header class="phone-header phone-conversation-header">
          <button type="button" class="phone-back" onClick=${back} aria-label="Back to sessions">‹</button>
          <span class="phone-header-status" role="img" data-state=${selected?.status} data-attention=${selectedAttention || undefined}
            aria-label=${'Session status: ' + (selectedAttention ? ATTENTION_LABELS[selectedAttention] : selected?.status || 'unknown')}/>
          <h1>${selected?.title || 'Session'}</h1>
          <button type="button" onClick=${() => setMore(true)} aria-label="Session menu">⋯</button>
        </header>`}
        ${id && selected?.status === 'error' && html`<p class="phone-session-error" role="alert" title=${selectedDetail}>Session error${selectedDetail ? ' · ' + selectedDetail : ''}</p>`}
        ${id && error && html`<p class="phone-error" role="alert">${error}</p>`}
        <main hidden=${!!id} class="phone-sessions">
          <header class="phone-header" data-searching=${searchOpen}>
            ${searchOpen ? html`<div class="phone-header-search">
              <input ref=${searchInput} aria-label="Search sessions or groups" placeholder="Search sessions or groups" value=${search}
                enterkeyhint="search" autocomplete="off" onInput=${e => setSearch(e.target.value)}
                onKeyDown=${e => { if (e.key === 'Escape') { e.preventDefault(); closeSearch() } }}/>
              ${search && html`<button type="button" class="phone-search-clear" aria-label="Clear search text" onClick=${() => { setSearch(''); searchInput.current?.focus() }}>×</button>`}
            </div>` : html`<h1>Sessions</h1>`}
            ${!searchOpen && totalAttention > 0 && html`<button type="button" class="phone-attention-filter" aria-pressed=${attentionOnly}
              onClick=${() => applyFilter(attentionOnly ? 'all' : 'attention')}><span>${totalAttention} ${totalAttention === 1 ? 'needs' : 'need'} you</span></button>`}
            ${!searchOpen && html`<button type="button" class="phone-header-icon" aria-label="Search" onClick=${() => { setFilterOpen(false); setSearchOpen(true) }}>${icon('search')}</button>`}
            <button type="button" ref=${filterButton} class="phone-header-icon" aria-label="Filter sessions" aria-haspopup="true" aria-expanded=${filterOpen}
              data-active=${filterActive} title=${filterActive ? 'Filter: ' + filterLabel : undefined} onClick=${() => setFilterOpen(!filterOpen)}>
              ${icon('filter')}${filterActive && html`<span class="phone-filter-dot" aria-hidden="true"/>`}</button>
            ${searchOpen ? html`<button type="button" class="phone-header-text" onClick=${closeSearch}>Cancel</button>` : html`
              <button type="button" class="phone-header-icon" aria-label="New session" disabled=${!canMutate} onClick=${() => openCreateSessionForGroup(groupPath || '')}>${icon('plus')}</button>
              <button type="button" class="phone-header-icon" aria-label="More" onClick=${() => setMore(true)}>${icon('more')}</button>`}
            ${refreshing && html`<span class="phone-refreshing" role="progressbar" aria-label="Refreshing sessions"/>`}
          </header>
          ${offline && html`<p class="phone-offline" role="status">Reconnecting…</p>`}
          ${error && html`<p class="phone-error" role="alert">${error}</p>`}
          ${filterOpen && html`<div class="phone-filter-scrim" onClick=${() => setFilterOpen(false)}/>
            <div class="phone-filter-menu" role="group" aria-label="Filter sessions">
              ${[['all', 'All'], ['running', 'Running'], ['waiting', 'Waiting for input'], ['attention', 'Needs attention']].map(([key, label]) => html`
                <button type="button" key=${key} aria-pressed=${filterKey === key} data-autofocus=${filterKey === key || undefined} onClick=${() => applyFilter(key)}>
                  <span>${label}</span>${key === 'attention' && totalAttention > 0 && html`<small>${totalAttention}</small>`}
                  <span class="phone-filter-check" aria-hidden="true">${filterKey === key ? '✓' : ''}</span>
                </button>`)}
            </div>`}
          <div ref=${list} class="phone-list" onTouchStart=${e => { touchStart.current = list.current.scrollTop <= 0 ? e.touches[0].clientY : null }}
            onTouchEnd=${e => { if (touchStart.current !== null && e.changedTouches[0].clientY - touchStart.current > 80) refresh(); touchStart.current = null }}>
            ${!sessionsLoadedSignal.value && html`<p>Loading sessions…</p>`}
            ${sessionsLoadedSignal.value && !sessions.length && html`<p>${remotes.length ? 'No local sessions yet.' : 'No sessions yet.'} Create a session to get started.</p>`}
            ${filtering && !groups.some(groupMatches) && !remotes.some(r => (r.sessions || []).some(s => remoteMatches(r, s))) && html`<p>No matches. <button onClick=${() => { setSearch(''); applyFilter('all') }}>Clear search</button></p>`}
            ${groups.filter(g => filtering ? groupMatches(g) : isGroupVisible(groupExpandedSignal.value, g.path)).map(g => html`
              <section key=${g.path} data-group-path=${g.path} class="phone-group" style=${{ '--group-depth': g.depth || 0 }}>
                <div class="phone-group-heading">
                  <button type="button" disabled=${!settings} aria-expanded=${filtering || isGroupOpen(groupExpandedSignal.value, g.path)} onClick=${() => toggleGroupOpen(g.path)}>
                    <span class="phone-group-name"><span class="phone-group-chevron" aria-hidden="true">${filtering || isGroupOpen(groupExpandedSignal.value, g.path) ? '▾' : '▸'}</span> ${g.name}</span>
                    <span class="phone-group-counts"><span>${g.sessionCount}</span>${attentionBadge(attentionCount(sessions, g.path))}</span>
                  </button>
                </div>
                ${(filtering || isGroupOpen(groupExpandedSignal.value, g.path)) && rows(g).map(localRow)}
              </section>`)}
            ${remoteError && html`<p role="alert">Remote sessions: ${remoteError}</p>`}
            ${remotes.map(remote => {
              const remoteGroupRows = remoteGroups(remote.sessions || [])
              const allSessions = remoteGroupRows.flatMap(g => g.sessions)
              return html`<section class="phone-group" key=${'remote:' + remote.name} aria-label=${'Remote ' + remote.name}>
              <div class="phone-group-heading"><button type="button" aria-expanded=${filtering || remoteGroupOpen(remote.name, '')} onClick=${() => toggleRemoteGroup(remote.name, '')}>
                <span class="phone-group-name"><span class="phone-group-chevron" aria-hidden="true">${filtering || remoteGroupOpen(remote.name, '') ? '▾' : '▸'}</span> ${remote.name} <small>${remote.online ? 'Online' : 'Offline'}${remote.stale ? ' · Stale' : ''}</small></span>
                <span class="phone-group-counts"><span>${allSessions.length}</span>${attentionBadge(allSessions.filter(s => sessionAttention(s)).length)}</span>
              </button></div>
              ${(filtering || remoteGroupOpen(remote.name, '')) && remoteGroupRows.filter(g => filtering ? remoteGroupMatches(remote, g, allSessions) : remoteGroupVisible(remote.name, g.path)).map(g => html`
                <section key=${g.path} data-remote-group-path=${g.path} class="phone-group" style=${{ '--group-depth': g.depth + 1 }}>
                  <div class="phone-group-heading"><button type="button" aria-expanded=${filtering || remoteGroupOpen(remote.name, g.path)} onClick=${() => toggleRemoteGroup(remote.name, g.path)}>
                    <span class="phone-group-name"><span class="phone-group-chevron" aria-hidden="true">${filtering || remoteGroupOpen(remote.name, g.path) ? '▾' : '▸'}</span> ${g.name}</span>
                    <span class="phone-group-counts"><span>${g.sessionCount}</span>${attentionBadge(attentionCount(allSessions, g.path))}</span>
                  </button></div>
                  ${(filtering || remoteGroupOpen(remote.name, g.path)) && remoteSessionRows(g.sessions, g.depth + 1, s => remoteMatches(remote, s)).map(row => remoteRow(remote, row))}
                </section>`)}
              ${!(remote.sessions || []).some(s => !s.archived) && html`<p>${remote.online ? 'No sessions' : 'Remote unavailable'}</p>`}
            </section>`})}
          </div>
        </main>
        ${id && html`<main class="phone-conversation">
          ${!isRemote && terminalID === id && Terminal && html`<${Terminal} inputControls=${true}/>`}
          <div class="phone-chat" hidden=${terminalID === id}>
            ${!profile || (isRemote && !remoteSelection) ? html`<p>Loading session…</p>` : html`<${SessionChat} key=${profile + '/' + id} sessionId=${selected?.id || id} active=${terminalID !== id} enabled=${isRemote ? !!remoteSelection?.remote.online : connection === 'connected'}
              endpoint=${isRemote ? '/api/remotes/' + encodeURIComponent(remoteSelection.remote.name) + '/sessions/' + encodeURIComponent(selected.id) : undefined} remote=${isRemote}
              interactiveMenu=${!isRemote && raw.get(id)?.substate === 'interactive-menu'} onOpenTerminal=${!isRemote ? () => setTerminalID(id) : undefined}
              sessionStatus=${selected?.status} mobileComposer=${true}
              initialText=${loadPhoneDraft(profile, id)} onTextChange=${text => savePhoneDraft(profile, id, text)}/>
            `}
          </div>
        </main>`}
      </div>
      ${more && html`<div class="phone-sheet-backdrop" onClick=${() => setMore(false)}>
        <section role="dialog" aria-modal="true" aria-label=${id ? 'Session menu' : 'More'} class="phone-sheet" onClick=${e => e.stopPropagation()}
          onKeyDown=${e => {
            if (e.key === 'Escape') setMore(false)
            if (e.key === 'Tab') {
              const buttons = e.currentTarget.querySelectorAll('button')
              const first = buttons[0], last = buttons[buttons.length - 1]
              if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
              else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
            }
          }}>
          <header><h2>${id ? selected?.title || 'Session' : 'More'}</h2><button ref=${closeButton} onClick=${() => setMore(false)}>Close</button></header>
          ${id ? html`
            <p>${[selected?.group, selected?.tool, selected?.status].filter(Boolean).join(' · ')}</p>
            ${!isRemote && html`<button onClick=${() => { setMore(false); setTerminalID(terminalID === id ? null : id) }}>${terminalID === id ? 'Return to Chat' : 'Open Terminal'}</button>`}
            ${selectedTarget && html`
              ${sessionBlocker && html`<p class="phone-action-reason" role="note">${sessionBlocker}</p>`}
              <button disabled=${!!sessionBlocker} onClick=${() => openAction('rename')}>Rename</button>
              <button disabled=${!!sessionBlocker} onClick=${() => openAction('move')}>Move to group</button>
              <button disabled=${!!sessionBlocker} onClick=${() => openAction('archive')}>Archive</button>
              <button class="phone-action-danger" disabled=${!!sessionBlocker} onClick=${() => openAction('delete')}>Delete</button>`}
          ` : html`
            <p>Profile: ${profileSignal.value || 'Loading…'}</p>
            <p>${connection === 'connected' ? 'Connected' : 'Reconnecting'} · ${canMutate ? 'Read and write' : 'Read-only'}</p>
            <button disabled=${refreshing} onClick=${() => { setMore(false); refresh() }}>${refreshing ? 'Refreshing…' : 'Refresh sessions'}</button>
            <button onClick=${() => { setMore(false); setArchivedOpen(true) }}>Archived sessions</button>
          `}
          <button onClick=${() => { if (isRemote) { window.history.replaceState(null, '', '/'); selectSession(null) }; useDesktopLayout(true) }}>Use desktop layout</button>
          ${!id && html`<p>Group management, notifications and advanced tools are available in desktop layout.</p>`}
        </section>
      </div>`}
      ${actionSheet && html`<${PhoneSessionSheet} key=${actionSheet.target.remote + '/' + actionSheet.target.id + '/' + actionSheet.view}
        target=${actionSheet.target} initialView=${actionSheet.view} settings=${settings}
        onClose=${() => setActionSheet(null)} onDone=${kind => actionDone(kind, actionSheet.target)}/>`}
      ${archivedOpen && html`<${PhoneArchivedSheet} settings=${settings} onClose=${() => setArchivedOpen(false)} onRestored=${refresh}/>`}
      ${createSessionDialogSignal.value && Create && html`<${Create}/>`}
      <${ToastContainer}/>
    </div>
  `
}
