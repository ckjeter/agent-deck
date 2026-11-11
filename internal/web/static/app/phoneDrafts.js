const prefix = 'agentdeck.phoneDraft.v1:'
const lifetime = 7 * 86400000
const keyFor = (profile, session) => prefix + JSON.stringify([profile, session])

export function loadPhoneDraft(profile, session, now = Date.now()) {
  try {
    const key = keyFor(profile, session)
    const value = JSON.parse(localStorage.getItem(key))
    if (typeof value?.text === 'string' && Number.isFinite(value.updatedAt) && value.updatedAt <= now && now - value.updatedAt < lifetime) return value.text
    localStorage.removeItem(key)
  } catch (_) {}
  return ''
}

export function savePhoneDraft(profile, session, text, now = Date.now()) {
  if (!profile || !session) return
  try {
    const key = keyFor(profile, session)
    if (text) localStorage.setItem(key, JSON.stringify({ text, updatedAt: now }))
    else localStorage.removeItem(key)
  } catch (_) {}
}

export function cleanPhoneDrafts(profile, sessions, now = Date.now(), scope = id => !id.startsWith('remote:')) {
  try {
    const ids = new Set(sessions)
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue
      try {
        const [savedProfile, id] = JSON.parse(key.slice(prefix.length))
        const text = loadPhoneDraft(savedProfile, id, now)
        if (!text || (savedProfile === profile && scope(id) && !ids.has(id))) localStorage.removeItem(key)
      } catch (_) { localStorage.removeItem(key) }
    }
  } catch (_) {}
}
