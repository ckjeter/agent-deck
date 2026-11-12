import { signal, computed } from '@preact/signals'

// A phone in landscape is wider than 720px, so a short touch screen counts too.
// Keep in sync with the phone-shell media queries in app.css.
export const PHONE_QUERY = '(max-width: 720px), (max-height: 500px) and (pointer: coarse)'
export const phoneViewportSignal = signal(!!window.matchMedia?.(PHONE_QUERY).matches)
let desktop = false
try { desktop = localStorage.getItem('agentdeck.phoneDesktop') === 'true' } catch (_) {}
export const phoneDesktopSignal = signal(desktop)
export const phoneShellSignal = computed(() => phoneViewportSignal.value && !phoneDesktopSignal.value)

export function useDesktopLayout(value) {
  phoneDesktopSignal.value = value
  try { localStorage.setItem('agentdeck.phoneDesktop', String(value)) } catch (_) {}
}

export function observePhoneViewport() {
  const media = window.matchMedia(PHONE_QUERY)
  const update = () => { phoneViewportSignal.value = media.matches }
  update()
  media.addEventListener('change', update)
  return () => media.removeEventListener('change', update)
}
