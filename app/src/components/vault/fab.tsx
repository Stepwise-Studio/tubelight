// The floating +: a circle above the nav (or the screen's bottom) on the right, as WhatsApp's, whose menu grows out of
// it in place. The Vault, Google Drive and the phone's folders each pass what can be added there.
import { useRef } from 'react'
import { View } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'

import { motion, useTheme } from '@/theme'
import { Press, elevation, haptic, showContextMenu, type MenuItem } from '@/ui'

const SIZE = 56

const BAR = { position: 'absolute', width: 18, height: 2, borderRadius: 1 } as const
const MORPH = { duration: motion.duration.fast, easing: motion.ease.smoothOut }

/** + when closed, ☰ when its menu is open: the + 's upright splits into the top and bottom lines (the middle line
 * stays), and folds back as the menu closes. Styles target the current state, so a re-render never snaps it. */
function Face({ open = false }: { open?: boolean }) {
  const { c } = useTheme()
  const top = useAnimatedStyle(() => ({ transform: [{ translateY: withTiming(open ? -6 : 0, MORPH) }, { rotate: withTiming(open ? '0deg' : '90deg', MORPH) }] }), [open])
  const bottom = useAnimatedStyle(() => ({ transform: [{ translateY: withTiming(open ? 6 : 0, MORPH) }, { rotate: withTiming(open ? '0deg' : '90deg', MORPH) }] }), [open])
  return (
    <View style={{ width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: c.solidTo, borderWidth: 1, borderColor: c.solidEdge }}>
      <Animated.View style={[BAR, { backgroundColor: c.solidInk }, top]} />
      <View style={[BAR, { backgroundColor: c.solidInk }]} />
      <Animated.View style={[BAR, { backgroundColor: c.solidInk }, bottom]} />
    </View>
  )
}

export function Fab({ items, bottom, label }: { items: () => MenuItem[]; bottom: number; label: string }) {
  const { scheme } = useTheme()
  const ref = useRef<View>(null)
  return (
    <View ref={ref} collapsable={false} style={[{ position: 'absolute', right: 16, bottom, borderRadius: SIZE / 2 }, elevation(scheme)]}>
      <Press radius={SIZE / 2} smoothing={0} onPress={() => { haptic.tap(); showContextMenu(ref.current, (open) => <Face open={open} />, items()) }} accessibilityLabel={label}>
        <Face />
      </Press>
    </View>
  )
}
