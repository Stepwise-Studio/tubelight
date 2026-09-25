import AsyncStorage from '@react-native-async-storage/async-storage'
import { createContext, use, useEffect, useState, type ReactNode } from 'react'
import { Appearance, Platform, useColorScheme } from 'react-native'

import { palettes, type ColorScheme, type Palette } from './tokens'

export type ThemePreference = 'system' | 'light' | 'dark'

const KEY = 'tubelight.theme'

interface ThemeValue {
  scheme: ColorScheme
  c: Palette
  preference: ThemePreference
  setPreference: (p: ThemePreference) => void
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme()
  const [preference, setPref] = useState<ThemePreference>('system')

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setPref(v)
    }).catch(() => {})
  }, [])

  // Keep native chrome (keyboard, alerts, vendored libs on `auto`) in step with the override.
  useEffect(() => {
    if (Platform.OS === 'web') return
    Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference)
  }, [preference])

  const setPreference = (p: ThemePreference) => {
    setPref(p)
    AsyncStorage.setItem(KEY, p).catch(() => {})
  }

  // Dark is the default when the system gives no answer.
  const scheme: ColorScheme = preference === 'system' ? (system === 'light' ? 'light' : 'dark') : preference
  return (
    <ThemeContext value={{ scheme, c: palettes[scheme], preference, setPreference }}>
      {children}
    </ThemeContext>
  )
}

export function useTheme() {
  const v = use(ThemeContext)
  if (!v) throw new Error('useTheme must be used inside ThemeProvider')
  return v
}
