import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

import { supabase } from '@/lib/supabase'

/** Current Supabase session. `ready` is false until the stored session has been read. */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      if (s) supabase.realtime.setAuth(s.access_token)
    })
    return () => data.subscription.unsubscribe()
  }, [])
  return { session, ready }
}
