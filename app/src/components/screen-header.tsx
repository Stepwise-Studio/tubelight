import { router } from 'expo-router'
import { type ReactNode } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons'

import { useTheme } from '@/theme'
import { IconButton, Text } from '@/ui'

/** Stack screen header: back, title (or custom middle), trailing actions. Hairline bottom edge. */
export function ScreenHeader({ title, subtitle, middle, right, onBack }: {
  title?: string
  subtitle?: string
  middle?: ReactNode
  right?: ReactNode
  onBack?: () => void
}) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ paddingTop: insets.top, backgroundColor: c.canvas, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 4 }}>
        <IconButton
          icon={ArrowLeft01Icon}
          accessibilityLabel="Back"
          iconSize={22}
          color="ink"
          onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          {middle ?? (
            <>
              {title && <Text variant="headline" numberOfLines={1} accessibilityRole="header">{title}</Text>}
              {subtitle && <Text variant="footnote" color="ink3" numberOfLines={1}>{subtitle}</Text>}
            </>
          )}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 4 }}>{right}</View>
      </View>
    </View>
  )
}

/** Tab root header: a large title with trailing actions. */
export function TabHeader({ title, right }: { title: string; right?: ReactNode }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', minHeight: 56 + insets.top }}>
      <Text variant="title" style={{ flex: 1 }} accessibilityRole="header" numberOfLines={1}>{title}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: -8 }}>{right}</View>
    </View>
  )
}

/** Minimal screen for routes another engineer builds next. */
export function PlaceholderScreen({ title, tab }: { title: string; tab?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      {tab ? <TabHeader title={title} /> : <ScreenHeader title={title} />}
    </View>
  )
}
