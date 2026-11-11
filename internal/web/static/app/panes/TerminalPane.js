import { phoneViewportSignal } from '../phoneLayout.js'
import { html } from 'htm/preact'
import { useState } from 'preact/hooks'
import { TerminalPanel } from '../TerminalPanel.js'
import { selectedIdSignal, selectedGroupSignal } from '../state.js'
import { activeTabSignal } from '../uiState.js'
import { useLazyComponent } from '../lazyModule.js'

function initialView() {
  try {
    const saved = localStorage.getItem('agentdeck.sessionView')
    if (saved === 'chat' || saved === 'terminal') return saved
  } catch (_) {}
  return window.matchMedia?.('(max-width: 720px)').matches ? 'chat' : 'terminal'
}

export function TerminalPane() {
  const [view, setView] = useState(initialView)
  const [terminalVisited, setTerminalVisited] = useState(view === 'terminal')
  const sessionId = selectedIdSignal.value
  const active = activeTabSignal.value === 'terminal' && !selectedGroupSignal.value
  const ChatPanel = useLazyComponent(view === 'chat', () => import('../SessionChat.js'), 'sessionChat', m => m.SessionChat)
  const choose = (next) => {
    setView(next)
    if (next === 'terminal') setTerminalVisited(true)
    try { localStorage.setItem('agentdeck.sessionView', next) } catch (_) {}
  }
  return html`
    <div class="term-wrap">
      <div class="session-view-toggle" role="group" aria-label="Session view">
        ${['terminal', 'chat'].map(mode => html`
          <button type="button" aria-pressed=${view === mode} onClick=${() => choose(mode)}>
            ${mode === 'terminal' ? 'Terminal' : 'Chat'}
          </button>
        `)}
      </div>
      ${(phoneViewportSignal.value ? view === 'terminal' : terminalVisited) && html`<div class="session-terminal" style=${{ display: view === 'terminal' ? 'flex' : 'none' }}><${TerminalPanel}/></div>`}
      ${view === 'chat' && (sessionId
        ? ChatPanel && html`<${ChatPanel} key=${sessionId} sessionId=${sessionId} active=${active}/>`
        : html`<div class="session-chat-empty">Select a session to read and send messages.</div>`)}
    </div>
  `
}
