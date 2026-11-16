// Turns agent-deck.recall.rows/v2 rows (GET /api/sessions/{id}/timeline)
// into chat messages. Mirrors chatMessages in internal/web/session_chat_history.go.

const TOOL_KINDS = new Set(['tool', 'bash', 'edit', 'read', 'subagent', 'todo', 'question', 'skill', 'thinking'])
const TOOL_TITLES = {
  bash: 'Run command', edit: 'Edit file', read: 'Read file', subagent: 'Subagent',
  todo: 'Update tasks', question: 'Question', skill: 'Skill', thinking: 'Thinking',
}

function compact(value, limit) {
  const chars = [...String(value || '').split(/\s+/).filter(Boolean).join(' ')]
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('')
}

function metaString(meta, key) {
  const value = meta?.[key]
  return typeof value === 'string' ? value : ''
}

function metaInt(meta, key) {
  const value = meta?.[key]
  return typeof value === 'number' ? Math.trunc(value) : undefined
}

function summarizeTool(row) {
  const tool = {
    kind: row.kind || undefined,
    title: compact(row.title, 120),
    target: compact(String(row.detail || '').split('\n', 1)[0], 200),
    result: compact(row.summary, 200),
    finished: row.finished,
    is_error: row.is_error,
    added: metaInt(row.meta, 'added'),
    removed: metaInt(row.meta, 'removed'),
  }
  if (!tool.title && row.kind) tool.title = TOOL_TITLES[row.kind] || 'Tool'
  if (!tool.result) tool.result = compact(metaString(row.meta, 'status'), 200)
  if (!tool.target) tool.target = compact(metaString(row.meta, 'path'), 200)
  if (row.kind === 'edit') tool.path = compact(row.detail, 240) || compact(metaString(row.meta, 'path'), 240)
  if (row.kind === 'thinking') {
    tool.title = 'Thinking'
    tool.detail = compact(row.body, 1200)
  }
  for (const key of Object.keys(tool)) if (tool[key] === undefined || tool[key] === '') delete tool[key]
  return tool
}

export function rowsToMessages(rows = []) {
  const messages = []
  for (const row of rows || []) {
    const m = { id: row.id }
    if (row.ts) m.timestamp = row.ts
    if (row.queued !== undefined) m.queued = row.queued
    const kind = row.kind || ''
    if (kind === 'user' || kind === 'assistant') {
      m.role = kind; m.content = row.body || ''
    } else if (kind === 'command') {
      m.role = 'user'; m.content = row.title || ''
    } else if (TOOL_KINDS.has(kind)) {
      m.role = 'assistant'; m.tools = true; m.tool = summarizeTool(row)
    } else if (kind === '') {
      if (row.queued === undefined && (row.finished !== undefined || row.is_error !== undefined || row.summary)) {
        m.role = 'assistant'; m.tools = true; m.tool = summarizeTool(row)
      } else if (row.queued === undefined) continue
    } else continue
    messages.push(m)
  }
  return messages
}
