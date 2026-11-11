export const ATTENTION_LABELS = {
  decision: 'Needs decision',
  waiting: 'Waiting for you',
  error: 'Error',
}

export function sessionAttention(session) {
  if (!session) return ''
  const substate = session.substate ?? session.raw?.substate ?? ''
  if (session.status === 'waiting' && substate === 'interactive-menu') return 'decision'
  if (session.status === 'waiting') return 'waiting'
  if (session.status === 'error') return 'error'
  return ''
}

export function attentionCount(sessions, groupPath) {
  return sessions.filter(session => !session.archived && sessionAttention(session) &&
    (session.group === groupPath || session.group?.startsWith(groupPath + '/'))).length
}
