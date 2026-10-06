// The full-screen frame around a file: photos and video on black under a floating header, documents on the canvas.
// Used for vault files and for files in chats; each passes its own actions.
import { router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowLeft01Icon } from '@hugeicons/core-free-icons'

import { formatSize, kindOf, type Viewable } from '@/lib/vault'
import { motion, useTheme } from '@/theme'
import { IconButton, Text } from '@/ui'

import { FileBody } from './viewers'

const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export function ViewerScreen({ item, shown, siblings = [], onIndex, actions }: {
  /** The file it opened on (photos: the first one shown). */
  item: Viewable
  /** The one on screen now (photos swipe), for the header. */
  shown?: Viewable
  siblings?: Viewable[]
  onIndex?: (v: Viewable) => void
  actions: (ink: string) => ReactNode
}) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const [bare, setBare] = useState(false) // photos: a tap hides the header for the picture alone
  const head = shown ?? item
  const kind = kindOf(head.name, head.mime)
  const dark = kind === 'image' || kind === 'video'
  const ink = dark ? '#fff' : c.ink
  const bar = 56 + insets.top
  const m = head.meta ?? {}
  const meta = [
    head.size ? formatSize(head.size) : null,
    kind === 'video' && m.duration && clockOf(m.duration),
    (kind === 'image' || kind === 'video') && m.width && m.height && `${m.width} × ${m.height}`,
    kind === 'pdf' && m.pages && `${m.pages} ${m.pages === 1 ? 'page' : 'pages'}`,
  ].filter(Boolean).join(' · ')
  return (
    <View style={{ flex: 1, backgroundColor: dark ? '#000' : c.canvas }}>
      <StatusBar style={dark ? 'light' : 'auto'} hidden={bare} />
      <FileBody item={item} siblings={siblings} onIndex={onIndex ?? (() => {})} chrome={{ top: dark ? 0 : bar, bottom: insets.bottom }}
        onTap={() => setBare((b) => !b)} />
      {!bare && <Animated.View entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)} style={{
        position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top, height: bar,
        backgroundColor: dark ? 'rgba(0,0,0,0.45)' : c.canvas, borderBottomWidth: dark ? 0 : 1, borderColor: c.line,
        flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2,
      }}>
        <IconButton icon={ArrowLeft01Icon} color={ink} iconSize={22} accessibilityLabel="Back" onPress={() => router.back()} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="headline" color={ink} numberOfLines={1}>{head.name}</Text>
          {!!meta && <Text variant="footnote" color={dark ? 'rgba(255,255,255,0.7)' : 'ink3'} numberOfLines={1} tabular>{meta}</Text>}
        </View>
        {actions(ink)}
      </Animated.View>}
    </View>
  )
}
