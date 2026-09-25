import { View } from 'react-native'

import type { LiveState } from '@/lib/types'

import { TextSwap } from './motion'
import { Orb, type OrbState } from './orb'

const orbFor = (state: LiveState, label?: string): OrbState => {
  if (state === 'tool') return label?.toLowerCase().startsWith('handing off') ? 'connecting' : 'searching'
  if (state === 'writing') return 'composing'
  if (state === 'waiting') return 'breathing'
  return 'working'
}

const defaultLabel: Record<LiveState, string> = {
  thinking: 'Thinking', tool: 'Working', writing: 'Writing', waiting: 'Waiting for your approval', idle: '',
}

/** "Teammate is thinking": a thinking orb plus a status label that swaps in place. */
export function ThinkingIndicator({ state, label }: { state: LiveState; label?: string }) {
  const text = label || defaultLabel[state]
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 }}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
    >
      <Orb state={orbFor(state, label)} />
      <TextSwap variant="caption" color="ink2">{text}</TextSwap>
    </View>
  )
}
