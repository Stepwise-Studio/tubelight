import { BlurView } from 'expo-blur'
import { useState } from 'react'
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { CheckListIcon, InboxIcon, UserCircleIcon, VaultIcon, WorkHistoryIcon } from '@hugeicons/core-free-icons'

import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Badge, Icon, Squircle, elevation, haptic, type IconSvgElement, Text } from '@/ui'

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const BAR_HEIGHT = 64
const GAP = 10

/** Space a scrolling tab screen must leave under its content for the floating capsule. */
export function useTabBarInset() {
  return BAR_HEIGHT + GAP + Math.max(useSafeAreaInsets().bottom, 12)
}

const icons: Record<string, IconSvgElement> = {
  index: InboxIcon, tasks: CheckListIcon, vault: VaultIcon, activity: WorkHistoryIcon, profile: UserCircleIcon,
}

/** Floating capsule (Telegram-style): blurred panel, a pill that slides to the active tab; Activity carries the
 * badge for approvals waiting on you. */
export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { pendingApprovals } = useWorkspace()
  const [slots, setSlots] = useState<{ x: number; w: number }[]>([])
  const cur = slots[state.index]
  const pill = useAnimatedStyle(() => cur
    ? {
        opacity: 1,
        width: withTiming(cur.w, { duration: motion.duration.fast, easing: motion.ease.smoothOut }),
        transform: [{ translateX: withTiming(cur.x, { duration: motion.duration.fast, easing: motion.ease.smoothOut }) }],
      }
    : { opacity: 0 }, [cur])

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(insets.bottom, 12), alignItems: 'center' }}
    >
      <View style={[{ borderRadius: BAR_HEIGHT / 2 }, elevation(scheme)]}>
        <Squircle style={{ height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
          {Platform.OS === 'ios' ? (
            <>
              <BlurView tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} intensity={80} style={StyleSheet.absoluteFill} />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: c.panel, opacity: 0.6 }]} />
            </>
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: c.panel }]} />
          )}
          <View style={{ flexDirection: 'row', padding: 6, height: BAR_HEIGHT }} accessibilityRole="tablist">
            <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 6, bottom: 6, left: 0, borderRadius: 26, backgroundColor: c.tubeSoft }, pill]} />
            {state.routes.map((route, i) => {
              const focused = state.index === i
              const label = descriptors[route.key].options.title ?? route.name
              const count = route.name === 'activity' ? pendingApprovals.length : 0
              return (
                <Pressable
                  key={route.key}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: focused }}
                  accessibilityLabel={count ? `${label}, ${count} waiting for you` : label}
                  onLayout={(e: LayoutChangeEvent) => {
                    const { x, width } = e.nativeEvent.layout
                    setSlots((s) => { const n = [...s]; n[i] = { x, w: width }; return n })
                  }}
                  onPress={() => {
                    const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
                    if (!focused && !e.defaultPrevented) { haptic.tap(); navigation.navigate(route.name, route.params) }
                  }}
                  onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
                  style={{ width: 66, alignItems: 'center', justifyContent: 'center', gap: 2 }}
                >
                  <View>
                    <Icon icon={icons[route.name] ?? InboxIcon} size={22} color={focused ? 'tube' : 'ink2'} strokeWidth={focused ? 2 : 1.5} />
                    <View style={{ position: 'absolute', top: -5, left: 14 }}><Badge count={count} /></View>
                  </View>
                  <Text variant="footnote" color={focused ? 'tube' : 'ink2'} style={{ fontSize: 11, lineHeight: 13 }} maxFontSizeMultiplier={1.1}>{label}</Text>
                </Pressable>
              )
            })}
          </View>
        </Squircle>
      </View>
    </View>
  )
}
