import { signal, computed } from '@preact/signals'

export const phoneViewportSignal = signal(!!window.matchMedia?.('(max-width: 720px)').matches)
let desktop = false
try { desktop = localStorage.getItem('agentdeck.phoneDesktop') === 'true' } catch (_) {}
export const phoneDesktopSignal = signal(desktop)
export const phoneShellSignal = computed(() => phoneViewportSignal.value && !phoneDesktopSignal.value)

export function useDesktopLayout(value) {
  phoneDesktopSignal.value = value
  try { localStorage.setItem('agentdeck.phoneDesktop', String(value)) } catch (_) {}
}

export function observePhoneViewport() {
  const media = window.matchMedia('(max-width: 720px)')
  const update = () => { phoneViewportSignal.value = media.matches }
  update()
  media.addEventListener('change', update)
  return () => media.removeEventListener('change', update)
}
