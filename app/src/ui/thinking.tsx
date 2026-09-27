import { View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import type { LiveState } from '@/lib/types'
import { ThinkingOrb } from '@/vendor/thinking-orbs-native'

import { motion, useTheme } from '@/theme'

import { ShimmerText } from './shimmer-text'

const defaultLabel: Record<LiveState, string> = {
  thinking: 'Thinking…', tool: 'Working…', writing: 'Writing…', waiting: 'Waiting for your approval', idle: '',
}

/**
 * "Teammate is working", as libraries.dev shows it: the striped `composing` orb in a capsule, and beside it
 * a live status line with a shimmer ("Thinking…" → "Fetching emails in Gmail"), each new step fading in.
 */
export function ThinkingIndicator({ state, label }: { state: LiveState; label?: string }) {
  const { c, scheme } = useTheme()
  const text = label || defaultLabel[state]
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start',
        height: 52, maxWidth: '100%', paddingLeft: 6, paddingRight: 20, borderRadius: 26,
        backgroundColor: c.panel, borderWidth: 1, borderColor: c.line,
      }}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
    >
      <ThinkingOrb state="composing" size={64} displaySize={40} theme={scheme} accessibilityLabel="" />
      <Animated.View key={text} entering={FadeIn.duration(motion.duration.fast)} style={{ flexShrink: 1 }}>
        <ShimmerText text={text} />
      </Animated.View>
    </View>
  )
}
