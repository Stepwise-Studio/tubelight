import { BlurView } from 'expo-blur'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import {
  Activity01Icon, BubbleChatIcon, CheckListIcon, Settings01Icon, UserGroupIcon,
} from '@hugeicons/core-free-icons'

import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Badge, Icon, haptic, type IconSvgElement, Text } from '@/ui'

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

export const TAB_BAR_HEIGHT = 56

/** Space a scrolling tab screen must leave under its content for the floating tab bar. */
export function useTabBarInset() {
  return TAB_BAR_HEIGHT + useSafeAreaInsets().bottom
}

const icons: Record<string, IconSvgElement> = {
  index: BubbleChatIcon, team: UserGroupIcon, approvals: CheckListIcon, activity: Activity01Icon, settings: Settings01Icon,
}

/** Custom tab bar: translucent panel, hairline top edge, tube-coloured active tab, Approvals badge. */
export function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { pendingApprovals } = useWorkspace()
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: insets.bottom, borderTopWidth: 1, borderTopColor: c.line }}>
      {Platform.OS === 'ios' ? (
        <>
          <BlurView tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} intensity={80} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: c.panel, opacity: 0.55 }]} />
        </>
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.panel, opacity: 0.97 }]} />
      )}
      <View style={{ flexDirection: 'row', height: TAB_BAR_HEIGHT }} accessibilityRole="tablist">
        {state.routes.map((route, i) => {
          const focused = state.index === i
          const { options } = descriptors[route.key]
          const label = options.title ?? route.name
          const count = route.name === 'approvals' ? pendingApprovals.length : 0
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={count ? `${label}, ${count} waiting` : label}
              onPress={() => {
                const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
                if (!focused && !e.defaultPrevented) { haptic.tap(); navigation.navigate(route.name, route.params) }
              }}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 }}
            >
              <View>
                <Icon icon={icons[route.name] ?? BubbleChatIcon} size={24} color={focused ? 'tube' : 'ink3'} strokeWidth={focused ? 2 : 1.5} />
                <View style={{ position: 'absolute', top: -4, left: 16 }}><Badge count={count} /></View>
              </View>
              <Text variant="footnote" color={focused ? 'ink' : 'ink3'} style={{ fontSize: 11, lineHeight: 13 }} maxFontSizeMultiplier={1.15}>{label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}
