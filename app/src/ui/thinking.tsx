import { View } from 'react-native'

import type { LiveState } from '@/lib/types'
import { useTheme } from '@/theme'
import { ThinkingOrb } from '@/vendor/thinking-orbs-native'

import { TextSwap } from './motion'

const defaultLabel: Record<LiveState, string> = {
  thinking: 'Thinking…', tool: 'Working…', writing: 'Writing…', waiting: 'Waiting for your approval', idle: '',
}

/**
 * "Teammate is thinking", as libraries.dev shows it: the 64 dp orb design (working) in a capsule with the
 * status label beside it. The label swaps in place ("Thinking…" → "Searching inbox").
 */
export function ThinkingIndicator({ state, label }: { state: LiveState; label?: string }) {
  const { c, scheme } = useTheme()
  const text = label || defaultLabel[state]
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start',
        height: 52, paddingLeft: 6, paddingRight: 20, borderRadius: 26,
        backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
      }}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
    >
      <ThinkingOrb state="working" size={64} displaySize={40} theme={scheme} accessibilityLabel="" />
      <TextSwap variant="body" color="ink3">{text}</TextSwap>
    </View>
  )
}
