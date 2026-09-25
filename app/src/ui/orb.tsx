import { ThinkingOrb, type OrbState } from '@/vendor/thinking-orbs-native'
import { useTheme } from '@/theme'

export type { OrbState }

/** libraries.dev thinking orb (Skia). */
export function Orb({ state, size = 20 }: { state: OrbState; size?: 20 | 64 }) {
  const { scheme } = useTheme()
  return <ThinkingOrb state={state} size={size} theme={scheme} accessibilityLabel="" />
}
