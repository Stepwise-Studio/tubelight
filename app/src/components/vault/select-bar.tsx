// The bar that floats over a list while several things are chosen: clear, how many, and what can be done to them all.
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { Cancel01Icon } from '@hugeicons/core-free-icons'

import { motion, useTheme } from '@/theme'
import { IconButton, Squircle, Text, elevation, haptic, type IconSvgElement } from '@/ui'

export interface BarAction { icon: IconSvgElement; label: string; onPress: () => unknown; color?: string }

export function SelectBar({ count, bottom, onClear, actions }: { count: number; bottom: number; onClear: () => void; actions: BarAction[] }) {
  const { c, scheme } = useTheme()
  return (
    <Animated.View entering={FadeInDown.duration(motion.duration.fast)} exiting={FadeOutDown.duration(motion.duration.quick)}
      style={[{ position: 'absolute', left: 16, right: 16, bottom: bottom + 8, borderRadius: 26 }, elevation(scheme)]}>
      <Squircle style={{ borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', padding: 6, gap: 2 }}>
        <IconButton icon={Cancel01Icon} round accessibilityLabel="Clear the selection" onPress={() => { haptic.tap(); onClear() }} />
        <Text variant="bodyMedium" style={{ flex: 1 }} tabular>{count} selected</Text>
        {actions.map((a) => (
          <IconButton key={a.label} icon={a.icon} color={a.color ?? c.ink2} accessibilityLabel={a.label} onPress={() => { haptic.tap(); a.onPress() }} />
        ))}
      </Squircle>
    </Animated.View>
  )
}
