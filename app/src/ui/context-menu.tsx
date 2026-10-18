// A context menu in place: the long-pressed thing stays lit where it is over a dim, and a Stepwise dropdown grows out
// of it (below when there's room, else above). For things on a page (folders); the action sheet (showMenu) stays for
// rows and headers.
import { useEffect, useState, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View, type View as RNView, useWindowDimensions } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { setPortal } from './portal'
import { Press } from './press'
import { Radio } from './radio'
import type { MenuItem } from './sheet'
import { Glass } from './glass'
import { elevation } from './surface'
import { Text } from './text'

const KEY = 'context-menu'
const MENU_W = 236
const ROW = 46
const ease = Easing.bezier(0.22, 1, 0.36, 1)

/** What stays lit in place: a node, or one drawn by open state (it changes when the menu opens and as it closes). */
type Preview = ReactNode | ((open: boolean) => ReactNode)

/** Opens a menu at `target` (the pressed view), showing `preview` lifted in its place. */
export function showContextMenu(target: RNView | null, preview: Preview, items: MenuItem[]) {
  if (!target) return
  target.measureInWindow((x, y, w, h) => {
    haptic.light()
    setPortal(KEY, <Layer at={{ x, y, w, h }} preview={preview} items={items} close={() => setPortal(KEY, null)} />)
  })
}

const CLOSE_MS = 180

function Layer({ at, preview, items, close }: { at: { x: number; y: number; w: number; h: number }; preview: Preview; items: MenuItem[]; close: () => void }) {
  // Opened a frame after mounting (so the preview can animate into its open look); closing plays out before removal.
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(t)
  }, [])
  const shut = () => {
    if (closing) return
    setClosing(true)
    setTimeout(close, CLOSE_MS)
  }
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { shut(); return true })
    return () => sub.remove()
  })
  const { scheme } = useTheme()
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
  const pick = (it: MenuItem) => { shut(); it.onPress() }
  return (
    <View style={StyleSheet.absoluteFill}>
      {!closing && (
        <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(CLOSE_MS)} style={StyleSheet.absoluteFill}>
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: scheme === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(9,9,11,0.28)' }]} onPress={shut} accessibilityLabel="Close the menu" />
        </Animated.View>
      )}
      <View pointerEvents="none" style={{ position: 'absolute', left: at.x, top: at.y, width: at.w, height: at.h }}>
        {typeof preview === 'function' ? preview(open && !closing) : preview}
      </View>
      {!closing && <Animated.View entering={grow} exiting={FadeOut.duration(120)}
        style={[{ position: 'absolute', left, top, width: MENU_W, borderRadius: 20, transformOrigin: origin }, elevation(scheme)]}>
        <Glass radius={20} veil={0.9} style={{ padding: 6 }}>
          {items.map((it) => (
            <Press key={it.label} radius={14} onPress={() => pick(it)} accessibilityLabel={it.label}
              style={{ height: ROW, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12 }}>
              {it.glyph ?? (it.icon && <Icon icon={it.icon} size={19} color={it.destructive ? 'danger' : 'ink2'} />)}
              <Text variant="bodyMedium" color={it.destructive ? 'danger' : 'ink'} numberOfLines={1} style={{ flex: 1 }}>{it.label}</Text>
              {it.checked !== undefined && <Radio checked={it.checked} />}
            </Press>
          ))}
        </Glass>
      </Animated.View>}
    </View>
  )
}
