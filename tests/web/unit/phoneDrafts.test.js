import { beforeEach, expect, it, vi } from 'vitest'
import { loadPhoneDraft, savePhoneDraft, cleanPhoneDrafts } from '../../../internal/web/static/app/phoneDrafts.js'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

it('restores exact text per profile and session and removes sent drafts', () => {
  savePhoneDraft('work', 'one', '中文\n  second line')
  savePhoneDraft('personal', 'one', 'Other profile')
  expect(loadPhoneDraft('work', 'one')).toBe('中文\n  second line')
  expect(loadPhoneDraft('personal', 'one')).toBe('Other profile')
  expect(loadPhoneDraft('work', 'two')).toBe('')
  savePhoneDraft('work', 'one', '')
  expect(loadPhoneDraft('work', 'one')).toBe('')
  expect(loadPhoneDraft('personal', 'one')).toBe('Other profile')
})

it('expires after seven days and cleans deleted sessions only in the authoritative profile', () => {
  const now = Date.now()
  savePhoneDraft('work', 'expired', 'Old', now - 7 * 86400000)
  savePhoneDraft('work', 'alive', 'Keep', now - 86400000)
  savePhoneDraft('work', 'deleted', 'Remove', now)
  savePhoneDraft('personal', 'one', 'Other', now)
  cleanPhoneDrafts('work', ['alive', 'expired'], now)
  expect(loadPhoneDraft('work', 'expired', now)).toBe('')
  expect(loadPhoneDraft('work', 'deleted', now)).toBe('')
  expect(loadPhoneDraft('work', 'alive', now)).toBe('Keep')
  expect(loadPhoneDraft('personal', 'one', now)).toBe('Other')
  expect(localStorage.length).toBe(2)
})

it('handles corrupt storage and denied access without breaking the composer', () => {
  savePhoneDraft('work', 'one', 'Draft')
  localStorage.setItem(localStorage.key(0), '{broken')
  expect(loadPhoneDraft('work', 'one')).toBe('')
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  expect(() => savePhoneDraft('work', 'one', 'Draft')).not.toThrow()
  expect(() => cleanPhoneDrafts('work', [])).not.toThrow()
  expect(loadPhoneDraft('work', 'one')).toBe('')
})
