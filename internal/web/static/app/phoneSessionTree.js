function visibleRows(rows, matches) {
  const matching = rows.map(row => matches(row.session))
  const context = new Set()
  let parent = -1
  rows.forEach((row, index) => {
    if (!row.nested) parent = index
    else if (matching[index] && parent >= 0) context.add(parent)
  })
  const visible = rows.filter((_, index) => matching[index] || context.has(index))
  return visible.map((row, index) => ({ ...row, contextOnly: !matches(row.session),
    lastChild: row.nested && !visible[index + 1]?.nested }))
}

export function localSessionRows(sessions, groupDepth, matches = () => true) {
  const base = groupDepth + 1
  return visibleRows(sessions.map(session => {
    const depth = Number.isInteger(session.level) && session.level >= base ? session.level : base
    return { session, depth, nested: depth > base }
  }), matches)
}

export function remoteSessionRows(sessions, groupDepth, matches = () => true) {
  const parentOf = new Map()
  let duplicate = false
  for (const session of sessions) {
    if (!session.id) continue
    if (parentOf.has(session.id)) duplicate = true
    parentOf.set(session.id, session.parent_session_id || session.parentSessionId || '')
  }
  const linked = id => parentOf.has(parentOf.get(id)) && parentOf.get(id) !== id
  const nested = new Map()
  if (!duplicate) {
    for (const [id, parent] of parentOf) {
      if (linked(id) && !linked(parent)) nested.set(id, parent)
    }
  }
  const children = new Map()
  const top = []
  for (const session of sessions) {
    if (nested.has(session.id)) {
      const parent = nested.get(session.id)
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(session)
    } else top.push(session)
  }
  const rows = []
  for (const session of top) {
    rows.push({ session, depth: groupDepth + 1, nested: false })
    for (const child of children.get(session.id) || []) rows.push({ session: child, depth: groupDepth + 2, nested: true })
  }
  return visibleRows(rows, matches)
}

export function remoteGroups(sessions) {
  const roots = []
  const byPath = new Map()
  for (const source of sessions) {
    if (source.archived) continue
    const parts = (source.group || '').trim().split('/').filter(Boolean)
    if (!parts.length) parts.push('my-sessions')
    const session = { ...source, group: parts.join('/') }
    let parent = null
    for (const name of parts) {
      const path = parent ? parent.path + '/' + name : name
      let group = byPath.get(path)
      if (!group) {
        group = { name, path, depth: parent ? parent.depth + 1 : 0, sessionCount: 0, sessions: [], children: [] }
        byPath.set(path, group)
        if (parent) parent.children.push(group)
        else roots.push(group)
      }
      group.sessionCount++
      parent = group
    }
    parent.sessions.push(session)
  }
  const groups = []
  const visit = siblings => {
    siblings.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const group of siblings) { groups.push(group); visit(group.children) }
  }
  visit(roots)
  return groups
}
