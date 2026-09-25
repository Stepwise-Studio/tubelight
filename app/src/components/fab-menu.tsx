import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { Add01Icon } from '@hugeicons/core-free-icons'

import { motion, useTheme } from '@/theme'
import { Icon, type IconSvgElement, Press, Squircle, Text, elevation, haptic } from '@/ui'

import { useTabBarInset } from './tab-bar'

export interface FabItem { label: string; icon: IconSvgElement; onPress: () => void }

/**
 * Telegram-position compose button that morphs into a WhatsApp-style menu.
 * Open 250ms / close 150ms on smooth-out; the menu grows from the button's corner.
 */
export function FabMenu({ items, accessibilityLabel = 'New' }: { items: FabItem[]; accessibilityLabel?: string }) {
  const { c, scheme } = useTheme()
  const bottom = useTabBarInset() + 16
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const p = useSharedValue(0)

  useEffect(() => {
    if (open) setMounted(true)
    p.value = withTiming(open ? 1 : 0, {
      duration: open ? motion.duration.fast : motion.duration.quick, easing: motion.ease.smoothOut,
    })
    if (!open) {
      const t = setTimeout(() => setMounted(false), motion.duration.quick)
      return () => clearTimeout(t)
    }
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setOpen(false); return true })
    return () => sub.remove()
  }, [open, p])

  const backdrop = useAnimatedStyle(() => ({ opacity: p.value }))
  const panel = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [
      { translateY: (1 - p.value) * motion.distance.base },
      { scale: motion.scale.medium + (1 - motion.scale.medium) * p.value },
    ],
  }))
  const plus = useAnimatedStyle(() => ({ transform: [{ rotate: `${p.value * 45}deg` }] }))

  const pick = (item: FabItem) => { setOpen(false); haptic.tap(); item.onPress() }

  return (
    <>
      {mounted && (
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(9,9,11,0.18)' }, backdrop]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close menu" />
        </Animated.View>
      )}
      {mounted && (
        <Animated.View
          style={[{ position: 'absolute', right: 16, bottom: bottom + 68, transformOrigin: 'bottom right' }, elevation(scheme), panel]}
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
          onPress={() => { haptic.tap(); setOpen((o) => !o) }}
          accessibilityLabel={open ? 'Close menu' : accessibilityLabel}
          accessibilityState={{ expanded: open }}
          style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center', backgroundColor: c.tube }}
        >
          <Animated.View style={plus}><Icon icon={Add01Icon} size={24} color={c.onTube} strokeWidth={2} /></Animated.View>
        </Press>
      </View>
    </>
  )
}
