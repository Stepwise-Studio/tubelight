// Which teammate answers when Tubelight is opened as the phone's assistant (long press on the side key). Kept on the
// phone: it's a per-device choice. Default: a chief-of-staff-like teammate, else the first one.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useEffect, useState } from 'react'

import type { Teammate } from './types'

const KEY = 'tubelight.assistant.teammate'

export function useAssistantMate(teammates: Teammate[]) {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => { AsyncStorage.getItem(KEY).then(setId, () => {}) }, [])
  const choose = (next: string) => { setId(next); AsyncStorage.setItem(KEY, next).catch(() => {}) }
  const mate = teammates.find((t) => t.id === id)
    ?? teammates.find((t) => /chief|assistant|operations|\bops\b/i.test(t.role)) ?? teammates[0]
  return { mate, choose }
}
