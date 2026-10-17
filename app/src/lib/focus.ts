import { useFocusEffect } from 'expo-router'
import { useCallback } from 'react'

/**
 * `useFocusEffect` that waits for the page to finish sliding in. Refreshing on focus fires network calls and state
 * updates (re-rendering big screens) in the very frames of the tab slide, which is where the stutter came from.
 */
export function useFocusLater(run: () => void, delay = 380) {
  useFocusEffect(useCallback(() => {
    const t = setTimeout(run, delay)
    return () => clearTimeout(t)
  }, [run, delay]))
}
