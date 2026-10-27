// The Garage card's colour (Profile → Preferences): auto follows the day (cream quiet, blue normal, orange busy), or
// one colour always. Kept on the phone.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'

export type GarageTone = 'auto' | 'cream' | 'blue' | 'orange'
const KEY = 'tl.garage.tone'
let now: GarageTone = 'auto'
const subs = new Set<() => void>()
AsyncStorage.getItem(KEY).then((v) => { if (v) { now = v as GarageTone; subs.forEach((f) => f()) } }, () => {})

export function setGarageTone(next: GarageTone) {
  now = next
  subs.forEach((f) => f())
  AsyncStorage.setItem(KEY, next).catch(() => {})
}
export const useGarageTone = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => now)
