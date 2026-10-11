// A context menu in place: the long-pressed thing stays lit where it is over a dim, and a Stepwise dropdown grows out
// of it (below when there's room, else above). For things on a page (folders); the action sheet (showMenu) stays for
// rows and headers.
import { type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View, type View as RNView, useWindowDimensions } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { setPortal } from './portal'
import { Press } from './press'
import type { MenuItem } from './sheet'
import { Squircle } from './squircle'
import { elevation } from './surface'
import { Text } from './text'

const KEY = 'context-menu'
const MENU_W = 236
const ROW = 46
const ease = Easing.bezier(0.22, 1, 0.36, 1)

/** Opens a menu at `target` (the pressed view), showing `preview` lifted in its place. */
export function showContextMenu(target: RNView | null, preview: ReactNode, items: MenuItem[]) {
  if (!target) return
  target.measureInWindow((x, y, w, h) => {
    haptic.light()
    let sub: { remove: () => void } | null = null
    const close = () => { sub?.remove(); setPortal(KEY, null) }
    sub = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true })
    setPortal(KEY, <Layer at={{ x, y, w, h }} preview={preview} items={items} close={close} />)
  })
}

function Layer({ at, preview, items, close }: { at: { x: number; y: number; w: number; h: number }; preview: ReactNode; items: MenuItem[]; close: () => void }) {
  const { c, scheme } = useTheme()
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const menuH = items.length * ROW + 12
  const below = at.y + at.h + 10 + menuH < height - insets.bottom - 16
  const top = below ? at.y + at.h + 8 : Math.max(insets.top + 8, at.y - menuH - 8)
  const left = Math.min(Math.max(16, at.x + at.w / 2 - MENU_W / 2), width - MENU_W - 16)
  const origin = [at.x + at.w / 2 - left, below ? 0 : menuH, 0] as [number, number, number]
  const grow = () => {
    'worklet'
    return {
      initialValues: { opacity: 0, transform: [{ scale: 0.4 }] },
      animations: { opacity: withTiming(1, { duration: 160, easing: ease }), transform: [{ scale: withTiming(1, { duration: 300, easing: ease }) }] },
    }
  }
  const pick = (it: MenuItem) => { close(); it.onPress() }
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)} style={StyleSheet.absoluteFill}>
        <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(9,9,11,0.28)' }]} onPress={close} accessibilityLabel="Close the menu" />
      </Animated.View>
      <View pointerEvents="none" style={{ position: 'absolute', left: at.x, top: at.y, width: at.w, height: at.h }}>{preview}</View>
      <Animated.View entering={grow} exiting={FadeOut.duration(120)}
        style={[{ position: 'absolute', left, top, width: MENU_W, borderRadius: 20, transformOrigin: origin }, elevation(scheme)]}>
        <Squircle style={{ borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 6 }}>
          {items.map((it) => (
            <Press key={it.label} radius={14} onPress={() => pick(it)} accessibilityLabel={it.label}
              style={{ height: ROW, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 }}>
              {it.icon && <Icon icon={it.icon} size={19} color={it.destructive ? 'danger' : 'ink2'} />}
              <Text variant="bodyMedium" color={it.destructive ? 'danger' : 'ink'} style={{ flex: 1 }}>{it.label}</Text>
            </Press>
          ))}
        </Squircle>
      </Animated.View>
    </View>
  )
}
