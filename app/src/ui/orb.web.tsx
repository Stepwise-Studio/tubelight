// Web preview: the web thinking-orbs package (DOM canvas).
import { ThinkingOrb, type OrbState } from 'thinking-orbs'

import { useTheme } from '@/theme'

export type { OrbState }

export function Orb({ state, size = 20 }: { state: OrbState; size?: 20 | 64 }) {
  const { scheme } = useTheme()
  return <ThinkingOrb state={state} size={size} theme={scheme} />
}
