import type { RealtimeChannel } from '@supabase/supabase-js'
import { AppState } from 'react-native'

import { supabase } from './supabase'

/**
 * A realtime channel that heals itself. Supabase closes a channel when its login token expires (a phone asleep for
 * an hour) and never resubscribes; errors and timeouts leave it dead too. On any of those, and whenever the app comes
 * back with the channel not joined, it's rebuilt with a fresh token. `onJoin` runs on every join: catch up there on
 * whatever was missed (`first` is the initial join).
 */
export function liveChannel(make: () => RealtimeChannel, onJoin: (first: boolean) => void) {
  let cur: RealtimeChannel | null = null
  let stopped = false
  let first = true
  let tries = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const start = async () => {
    const { data } = await supabase.auth.getSession()
    if (stopped) return
    if (data.session) await supabase.realtime.setAuth(data.session.access_token)
    const ch = make()
    cur = ch
    ch.subscribe((status) => {
      if (ch !== cur || stopped) return // a channel we already let go of
      // Joined (maybe rejoined by the library itself after an error): any rebuild still pending is moot.
      if (status === 'SUBSCRIBED') { clearTimeout(timer); tries = 0; onJoin(first); first = false } else restart()
    })
  }
  const restart = (delay = Math.min(2000 * 2 ** tries, 30_000)) => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (stopped) return
      tries++
      const old = cur
      cur = null
      if (old) await supabase.removeChannel(old) // the same topic can't be joined again while this one is registered
      start()
    }, delay)
  }
  const app = AppState.addEventListener('change', (s) => {
    if (s === 'active' && cur && cur.state !== 'joined') restart(0)
  })
  start()
  return {
    get channel() { return cur },
    stop() {
      stopped = true
      clearTimeout(timer)
      app.remove()
      if (cur) supabase.removeChannel(cur)
      cur = null
    },
  }
}
