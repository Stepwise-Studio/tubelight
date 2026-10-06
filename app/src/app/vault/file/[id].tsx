import { router, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft01Icon, MoreHorizontalIcon, Share08Icon, StarIcon } from '@hugeicons/core-free-icons'

import { itemMenu, shareItem, toggleStar } from '@/components/vault/actions'
import { FileBody } from '@/components/vault/viewers'
import { byFolderThenNewest, formatSize, kindOf, useVault, type VaultItem } from '@/lib/vault'
import { motion, useTheme } from '@/theme'
import { IconButton, Text } from '@/ui'

/** One file, full screen: photos and video on black under a floating header; documents on the canvas. */
export default function VaultFile() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { items } = useVault()
  const opened = items?.find((r) => r.id === id)
  const [currentId, setCurrentId] = useState(id) // the photo swiped to
  const item = items?.find((r) => r.id === currentId) ?? opened
  useEffect(() => { if (items && !items.some((r) => r.id === currentId)) router.back() }, [items, currentId]) // deleted

  const siblings = useMemo(() => (opened && items ? items.filter((r) => r.parent === opened.parent && r.kind === 'file' && kindOf(r.name, r.mime) === 'image').sort(byFolderThenNewest) : []), [items, opened])
  if (!item) return <View style={{ flex: 1, backgroundColor: c.canvas }} />
  const kind = kindOf(item.name, item.mime)
  const dark = kind === 'image' || kind === 'video'
  const ink = dark ? '#fff' : c.ink
  const bar = 56 + insets.top
  const meta = [formatSize(item.size), item.meta?.width && item.meta?.height && `${item.meta.width} × ${item.meta.height}`, item.meta?.pages && `${item.meta.pages} pages`].filter(Boolean).join(' · ')
  return (
    <View style={{ flex: 1, backgroundColor: dark ? '#000' : c.canvas }}>
      <StatusBar style={dark ? 'light' : 'auto'} />
      <View style={{ flex: 1, paddingTop: dark ? 0 : 0 }}>
        <FileBody item={opened ?? item} siblings={siblings} onIndex={(r: VaultItem) => setCurrentId(r.id)} chrome={{ top: dark ? 0 : bar, bottom: insets.bottom }} />
      </View>
      <Animated.View entering={FadeIn.duration(motion.duration.fast)} style={{
        position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top, height: bar,
        backgroundColor: dark ? 'rgba(0,0,0,0.45)' : c.canvas, borderBottomWidth: dark ? 0 : 1, borderColor: c.line,
        flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2,
      }}>
        <IconButton icon={ArrowLeft01Icon} color={ink} iconSize={22} accessibilityLabel="Back" onPress={() => router.back()} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="headline" color={ink} numberOfLines={1}>{item.name}</Text>
          <Text variant="footnote" color={dark ? 'rgba(255,255,255,0.7)' : 'ink3'} numberOfLines={1} tabular>{meta}</Text>
        </View>
        <IconButton icon={StarIcon} color={item.starred ? c.warning : ink} accessibilityLabel={item.starred ? 'Unstar' : 'Star'} onPress={() => toggleStar(item)} />
        <IconButton icon={Share08Icon} color={ink} accessibilityLabel="Share" onPress={() => shareItem(item)} />
        <IconButton icon={MoreHorizontalIcon} color={ink} accessibilityLabel="More" onPress={() => itemMenu(item)} />
      </Animated.View>
    </View>
  )
}
