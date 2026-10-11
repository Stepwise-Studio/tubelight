import { AppState } from 'react-native'

/**
 * Runs `fn` when the app comes back after being away for at least `minAwayMs`. A permission dialog, the share sheet
 * or a settings page puts the app in the background for a moment each time: that's a blip, not a return, and catching
 * up on every one (five permission dialogs in a row) made the app crawl.
 */
export function onReturn(fn: () => void, minAwayMs = 30_000) {
  let left = 0
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') {
      if (left && Date.now() - left >= minAwayMs) fn()
      left = 0
    } else if (!left) left = Date.now()
  })
  return () => sub.remove()
}
