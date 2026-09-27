import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut, Keyframe } from 'react-native-reanimated'
import { Add01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'

import { motion, useTheme } from '@/theme'
import { Icon, IconSwap, type IconSvgElement, Press, Squircle, Text, elevation, haptic } from '@/ui'

import { useTabBarInset } from './tab-bar'

export interface FabItem { label: string; icon: IconSvgElement; onPress: () => void }

/**
 * Telegram-position compose button that morphs into a WhatsApp-style menu.
 * Open 250ms / close 150ms on smooth-out; the menu grows from the button's corner.
 */
// The menu grows from the button's corner: 250ms in, 150ms out, smooth out.
const menuIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: motion.distance.base }, { scale: motion.scale.medium }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: motion.ease.smoothOut },
}).duration(motion.duration.fast)
const menuOut = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
  100: { opacity: 0, transform: [{ translateY: motion.distance.base }, { scale: motion.scale.medium }], easing: motion.ease.smoothOut },
}).duration(motion.duration.quick)

export function FabMenu({ items, accessibilityLabel = 'New' }: { items: FabItem[]; accessibilityLabel?: string }) {
  const { c, scheme } = useTheme()
  const bottom = useTabBarInset() + 16
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setOpen(false); return true })
    return () => sub.remove()
  }, [open])

  const pick = (item: FabItem) => { setOpen(false); haptic.tap(); item.onPress() }

  return (
    <>
      {open && (
        <Animated.View
          entering={FadeIn.duration(motion.duration.fast).easing(motion.ease.smoothOut)}
          exiting={FadeOut.duration(motion.duration.quick)}
          style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(9,9,11,0.18)' }]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close menu" />
        </Animated.View>
      )}
      {open && (
        <Animated.View
          entering={menuIn}
          exiting={menuOut}
          style={[{ position: 'absolute', right: 16, bottom: bottom + 68, transformOrigin: 'bottom right' }, elevation(scheme)]}
          accessibilityViewIsModal
        >
          <Squircle style={{ borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 6, minWidth: 220 }}>
            {items.map((item) => (
              <Press
                key={item.label}
                radius={14}
                onPress={() => pick(item)}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 48, paddingHorizontal: 12 }}
              >
                <Icon icon={item.icon} size={20} color="ink2" />
                <Text variant="bodyMedium">{item.label}</Text>
              </Press>
            ))}
          </Squircle>
        </Animated.View>
      )}
      <View style={[{ position: 'absolute', right: 16, bottom }, elevation(scheme)]}>
        <Press
          radius={28}
          onPress={() => { haptic.tap(); setOpen(!open) }}
          accessibilityLabel={open ? 'Close menu' : accessibilityLabel}
          accessibilityState={{ expanded: open }}
          style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center', backgroundColor: c.tube }}
        >
          <IconSwap swapKey={open ? 'close' : 'add'}><Icon icon={open ? Cancel01Icon : Add01Icon} size={24} color={c.onTube} strokeWidth={2} /></IconSwap>
        </Press>
      </View>
    </>
  )
}
