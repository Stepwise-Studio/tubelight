import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, {
  runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon } from '@hugeicons/core-free-icons'

import { motion, radius, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon, type IconSvgElement } from './icon'
import { ListRow } from './list-row'
import { Portal } from './portal'
import { Press } from './press'
import { elevation } from './surface'
import { Glass } from './glass'
import { Radio } from './radio'
import { Text } from './text'

const { duration, ease } = motion

export interface SheetProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  /** Accessible name when there is no visible title. */
  accessibilityLabel?: string
}

/**
 * Bottom sheet. A floating squircle (radius 28, inset 8 so it sits concentric with the screen
 * corners) that slides up over a scrim (panel reveal: open 400ms, close 350ms, smooth out).
 * Drag down or tap the scrim to dismiss; Android back closes it; rides above the keyboard.
 */
export function Sheet({ open, onClose, title, children, accessibilityLabel }: SheetProps) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  if (!mounted) return null
  return (
    <Portal>
      <SheetBody open={open} onClose={onClose} onGone={() => setMounted(false)} title={title} accessibilityLabel={accessibilityLabel}>
        {children}
      </SheetBody>
    </Portal>
  )
}

function SheetBody({ open, onClose, onGone, title, children, accessibilityLabel }: SheetProps & { onGone: () => void }) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { height: screenH } = useWindowDimensions()
  const reduced = useReducedMotion()
  const kb = useReanimatedKeyboardAnimation()
  const y = useSharedValue(screenH)
  const shown = useSharedValue(0)

  useEffect(() => {
    if (open) {
      y.value = reduced ? 0 : withTiming(0, { duration: duration.slow, easing: ease.smoothOut })
      shown.value = withTiming(1, { duration: duration.slow, easing: ease.smoothOut })
    } else {
      shown.value = withTiming(0, { duration: duration.medium, easing: ease.smoothOut })
      y.value = withTiming(reduced ? 0 : screenH * 0.6, { duration: duration.medium, easing: ease.smoothOut }, (done) => {
        if (done) runOnJS(onGone)()
      })
    }
  }, [open, reduced, screenH, shown, y, onGone])

  useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true })
    return () => sub.remove()
  }, [open, onClose])

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-20, 20])
    .onUpdate((e) => { y.set(Math.max(0, e.translationY) + Math.min(0, e.translationY) * 0.1) })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 900) runOnJS(onClose)()
      else y.set(withSpring(0, motion.spring))
    })

  const scrim = useAnimatedStyle(() => ({ opacity: shown.value }))
  const panel = useAnimatedStyle(() => ({ opacity: reduced ? shown.value : 1, transform: [{ translateY: y.value + kb.height.value }] }))

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, scrim]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={accessibilityLabel ?? title}
          style={[{ position: 'absolute', left: 8, right: 8, bottom: Math.max(insets.bottom, 8), borderRadius: radius.sheet, maxHeight: screenH - insets.top - 24 }, elevation(scheme, 2), panel]}
        >
          <Glass radius={radius.sheet} veil={0.92} style={{ paddingBottom: 12 }}>
            <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: title ? 4 : 8 }}>
              <View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: c.lineStrong }} />
            </View>
            {title && <Text variant="headline" style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 }} accessibilityRole="header">{title}</Text>}
            {children}
          </Glass>
        </Animated.View>
      </GestureDetector>
    </View>
  )
}

// ------------------------------------------------------------------ Menu / action sheet

export interface MenuItem {
  label: string
  /** The current setting, on the right (a menu item that opens its choices). */
  value?: string
  /** One of several choices: a radio on the right, filled for the current one. */
  checked?: boolean
  icon?: IconSvgElement
  /** Drawn in the icon's place when an icon font glyph won't do (a status's own mark). */
  glyph?: ReactNode
  destructive?: boolean
  onPress: () => void
}
/** An emoji bar above the actions (reacting to a message, as in WhatsApp). */
export interface MenuReactions { emojis: readonly string[]; selected?: string; onPick: (emoji: string) => void; onMore?: () => void }
interface MenuState { title?: string; message?: string; items: MenuItem[]; reactions?: MenuReactions; open: boolean }

let menu: MenuState = { items: [], open: false }
const menuListeners = new Set<() => void>()
const setMenu = (m: MenuState) => { menu = m; menuListeners.forEach((l) => l()) }

/** Action sheet: `showMenu({ title, items: [{ label, icon, onPress }] })`. Needs <MenuHost/>. */
export function showMenu(opts: { title?: string; message?: string; items: MenuItem[]; reactions?: MenuReactions }) {
  haptic.light()
  setMenu({ ...opts, open: true })
}

export function MenuHost() {
  const m = useSyncExternalStore((l) => { menuListeners.add(l); return () => { menuListeners.delete(l) } }, () => menu, () => menu)
  const { c } = useTheme()
  const close = () => setMenu({ ...menu, open: false })
  return (
    <Sheet open={m.open} onClose={close} accessibilityLabel={m.title ?? 'Actions'}>
      {m.reactions && (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 }} accessibilityRole="toolbar">
          {m.reactions.emojis.map((e) => {
            const on = m.reactions?.selected === e
            return (
              <Press
                key={e}
                radius={24}
                haptic="tap"
                onPress={() => { close(); m.reactions?.onPick(e) }}
                accessibilityRole="button"
                accessibilityLabel={on ? `Remove ${e} reaction` : `React ${e}`}
                accessibilityState={{ selected: on }}
                style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.tubeSoft : c.panel2 }}
              >
                <Text style={{ fontSize: 24, lineHeight: 30 }}>{e}</Text>
              </Press>
            )
          })}
          {m.reactions.onMore && (
            <Press
              radius={24}
              haptic="tap"
              onPress={() => { close(); m.reactions?.onMore?.() }}
              accessibilityRole="button"
              accessibilityLabel="More reactions"
              style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel2 }}
            >
              <Icon icon={Add01Icon} size={22} color="ink2" />
            </Press>
          )}
        </View>
      )}
      {(m.title || m.message) && (
        <View style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 2 }}>
          {m.title && <Text variant="label" color="ink2">{m.title}</Text>}
          {m.message && <Text variant="caption" color="ink3" tabular>{m.message}</Text>}
        </View>
      )}
      <View style={{ paddingHorizontal: 8 }}>
        {m.items.map((it) => (
          <ListRow
            key={it.label}
            title={it.label}
            destructive={it.destructive}
            accessory={it.checked !== undefined ? <Radio checked={it.checked} /> : it.value ? <Text variant="caption" color="ink3">{it.value}</Text> : undefined}
            chevron={!!it.value && it.checked === undefined}
            leading={it.glyph ?? (it.icon && <Icon icon={it.icon} size={20} color={it.destructive ? 'danger' : 'ink2'} />)}
            onPress={() => { close(); it.onPress() }}
            style={{ minHeight: 52 }}
          />
        ))}
      </View>
    </Sheet>
  )
}
