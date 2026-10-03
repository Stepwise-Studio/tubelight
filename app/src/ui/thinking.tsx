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
 * "Teammate is working", as libraries.dev shows it: the striped `composing` orb and beside it a live status line with
 * a shimmer ("Thinking…" → "Fetching emails in Gmail"), each new step fading in. Bare, no capsule: it sits in the
 * chat like a line of text.
 */
export function ThinkingIndicator({ state, label }: { state: LiveState; label?: string }) {
  const { scheme } = useTheme()
  const text = label || defaultLabel[state]
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 32, maxWidth: '100%' }}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
    >
      <View style={{ marginLeft: -4 }}>
        <ThinkingOrb state="composing" size={32} displaySize={28} theme={scheme} accessibilityLabel="" />
      </View>
      <Animated.View key={text} entering={FadeIn.duration(motion.duration.fast)} style={{ flexShrink: 1 }}>
        <ShimmerText text={text} size={13} />
      </Animated.View>
    </View>
  )
}
