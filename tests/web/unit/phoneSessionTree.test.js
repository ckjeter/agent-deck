import { expect, it } from 'vitest'
import { localSessionRows, remoteSessionRows, remoteGroups } from '../../../internal/web/static/app/phoneSessionTree.js'

it('preserves local TUI order and authoritative depths, including flat orphans', () => {
  const sessions = [{ id: 'parent', level: 2 }, { id: 'child', level: 3, parent: 'parent' },
    { id: 'orphan', level: 2, parent: 'missing', isSubSession: true }, { id: 'grandchild', level: 2, parent: 'child' }]
  const rows = localSessionRows(sessions, 1)
  expect(rows.map(row => row.session.id)).toEqual(['parent', 'child', 'orphan', 'grandchild'])
  expect(rows.map(row => row.depth)).toEqual([2, 3, 2, 2])
  expect(rows.map(row => row.nested)).toEqual([false, true, false, false])
  expect(rows[1].lastChild).toBe(true)
})

it('falls back to the owning group when the local level is absent or invalid', () => {
  expect(localSessionRows([{ id: 'one' }, { id: 'two', level: 0 }], 2).map(row => row.depth)).toEqual([3, 3])
})

it('groups remote children immediately after their parent in stable sibling order', () => {
  const rows = remoteSessionRows([
    { id: 'child-two', parent_session_id: 'parent' }, { id: 'other' },
    { id: 'parent' }, { id: 'child-one', parentSessionId: 'parent' },
  ], 1)
  expect(rows.map(row => row.session.id)).toEqual(['other', 'parent', 'child-two', 'child-one'])
  expect(rows.map(row => row.depth)).toEqual([2, 2, 3, 3])
  expect(rows.map(row => row.lastChild)).toEqual([false, false, false, true])
})

it('keeps grandchildren, missing parents, and cycles flat like the remote TUI', () => {
  const rows = remoteSessionRows([
    { id: 'parent' }, { id: 'child', parent_session_id: 'parent' },
    { id: 'grand', parent_session_id: 'child' }, { id: 'orphan', parent_session_id: 'gone' },
    { id: 'x', parent_session_id: 'y' }, { id: 'y', parent_session_id: 'x' },
  ], 0)
  expect(rows.map(row => row.nested)).toEqual([false, true, false, false, false, false])
})

it('does not guess parent relationships for duplicate IDs', () => {
  expect(remoteSessionRows([{ id: 'same' }, { id: 'same' }, { id: 'child', parent_session_id: 'same' }], 0)
    .map(row => row.nested)).toEqual([false, false, false])
})

it('orders remote groups by TUI fallback path order and normalizes the default group', () => {
  const groups = remoteGroups([
    { id: 'z', group: 'Z/sub' }, { id: 'b', group: 'A/sub' }, { id: 'a', group: 'A' },
    { id: 'default', group: '' }, { id: 'archived', group: 'Hidden', archived: true },
  ])
  expect(groups.map(group => group.path)).toEqual(['A', 'A/sub', 'Z', 'Z/sub', 'my-sessions'])
  expect(groups.find(group => group.path === 'A').sessionCount).toBe(2)
  expect(groups.at(-1).sessions[0].id).toBe('default')
})

it('retains parent context for a matching child without bringing in unrelated siblings', () => {
  const rows = localSessionRows([{ id: 'parent', level: 1 }, { id: 'first-child', level: 2 },
    { id: 'wanted-child', level: 2 }, { id: 'other', level: 1 }], 0, s => s.id === 'wanted-child')
  expect(rows.map(row => row.session.id)).toEqual(['parent', 'wanted-child'])
  expect(rows.map(row => row.contextOnly)).toEqual([true, false])
  expect(rows[1].lastChild).toBe(true)
})

it('never attaches a remote child to a parent in a different group or archive partition', () => {
  const groups = remoteGroups([{ id: 'parent', group: 'A' },
    { id: 'cross-group', group: 'B', parent_session_id: 'parent' },
    { id: 'archived-parent', group: 'B', archived: true },
    { id: 'orphan', group: 'B', parent_session_id: 'archived-parent' }])
  const rows = groups.flatMap(g => remoteSessionRows(g.sessions, g.depth))
  expect(rows.map(row => row.session.id)).toEqual(['parent', 'cross-group', 'orphan'])
  expect(rows.every(row => !row.nested)).toBe(true)
})
