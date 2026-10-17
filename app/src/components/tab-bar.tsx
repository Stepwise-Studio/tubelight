// Navigation: a floating capsule of five places with a pill that slides to the one you're on.
import { Pressable, View, useWindowDimensions } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import { useEffect, useRef } from 'react'
import { CircleCheckIcon, InboxIcon, UserCircleIcon, VaultIcon, WorkHistoryIcon } from '@hugeicons/core-free-icons'

import { isUnread } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Badge, Icon, Squircle, elevation, haptic } from '@/ui'

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const BAR = 64
const GAP = 10

const PLACES = [
  { name: 'index', label: 'Inbox', icon: InboxIcon },
  { name: 'vault', label: 'Vault', icon: VaultIcon },
  { name: 'tasks', label: 'Tasks', icon: CircleCheckIcon },
  { name: 'activity', label: 'Activity', icon: WorkHistoryIcon },
  { name: 'profile', label: 'Profile', icon: UserCircleIcon },
]
const ease = motion.ease.smoothOut

/** Space a scrolling tab screen must leave under its content for the floating bar. */
export function useTabBarInset() {
  return BAR + GAP + Math.max(useSafeAreaInsets().bottom, 12)
}

export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { width: screen } = useWindowDimensions()
  const ws = useWorkspace()

  const current = state.routes[state.index]?.name
  const unread = ws.threads.some(isUnread)
  const waiting = ws.pendingApprovals.length
  const badge = (name: string) => (name === 'activity' ? waiting : 0)
  const dot = (name: string) => name === 'index' && unread

  const slot = (screen - 32 - 12) / PLACES.length
  const at = Math.max(0, PLACES.findIndex((p) => p.name === current))

  // The pill (transitions.dev tabs sliding) runs on the UI thread and starts on the press itself, before React renders
  // the new page; the render only catches it up when the tab changed some other way (a link, a notification).
  const x = useSharedValue(6 + at * slot)
  const target = useRef(6 + at * slot)
  const slide = (to: number) => {
    if (to === target.current) return
    target.current = to
    x.value = withTiming(to, { duration: motion.duration.fast, easing: ease })
  }
  useEffect(() => { slide(6 + at * slot) })
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))

  // Every tab mounts once the app has settled, so the first visit slides in a ready page instead of building one.
  useEffect(() => {
    const t = setTimeout(() => PLACES.forEach((p) => p.name !== current && navigation.preload(p.name)), 1500)
    return () => clearTimeout(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const go = (name: string) => {
    if (name === current) return
    const route = state.routes.find((r) => r.name === name)
    if (!route) return
    haptic.tap()
    slide(6 + PLACES.findIndex((p) => p.name === name) * slot)
    const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
    if (!e.defaultPrevented) navigation.navigate(name)
  }


  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12), zIndex: 2 }}>
      <View style={[{ borderRadius: BAR / 2 }, elevation(scheme)]}>
        <Squircle style={{ height: BAR, borderRadius: BAR / 2, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}
          accessibilityRole="tablist">
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 6, bottom: 6, width: slot, borderRadius: 26, backgroundColor: c.tubeSoft }, pill]} />
          {PLACES.map((p) => {
            const on = current === p.name
            return (
              <Pressable key={p.name} onPress={() => go(p.name)}
                accessibilityRole="tab" accessibilityState={{ selected: on }}
                accessibilityLabel={badge(p.name) ? `${p.label}, ${badge(p.name)} waiting` : p.label}
                style={{ width: slot, height: BAR - 12, alignItems: 'center', justifyContent: 'center' }}>
                <Icon icon={p.icon} size={24} color={on ? 'tube' : 'ink3'} strokeWidth={on ? 2 : 1.6} />
                <Marker count={badge(p.name)} dot={dot(p.name)} />
              </Pressable>
            )
          })}
        </Squircle>
      </View>
    </View>
  )
}

/** A count (approvals) or a dot (something new) on a bar icon. */
function Marker({ count = 0, dot }: { count?: number; dot?: boolean }) {
  const { c } = useTheme()
  if (count) return <View style={{ position: 'absolute', top: 6, right: 6 }}><Badge count={count} /></View>
  if (!dot) return null
  return <View style={{ position: 'absolute', top: 10, right: 12, width: 9, height: 9, borderRadius: 4.5, backgroundColor: c.tube, borderWidth: 1.5, borderColor: c.panel }} />
}

