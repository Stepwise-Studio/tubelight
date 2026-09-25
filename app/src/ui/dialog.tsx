import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import Animated, { Keyframe, FadeIn, FadeOut } from 'react-native-reanimated'

import { motion, radius, useTheme } from '@/theme'

import { Button } from './button'
import { Portal } from './portal'
import { elevation } from './surface'
import { Squircle } from './squircle'
import { Text } from './text'

const { duration, ease, scale } = motion

// transitions.dev modal: open 250ms from 0.96, close 150ms back to 0.96, smooth out.
const modalIn = new Keyframe({
  0: { opacity: 0, transform: [{ scale: scale.large }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: ease.smoothOut },
}).duration(duration.fast)
const modalOut = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: scale.large }], easing: ease.smoothOut },
}).duration(duration.quick)

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  body?: string
  children?: ReactNode
  /** Buttons, right-aligned. Verb-first labels that repeat the consequence. */
  actions?: ReactNode
}

/** Centered modal card (radius 20). Scrim tap and Android back close it. */
export function Dialog({ open, onClose, title, body, children, actions }: DialogProps) {
  const { c, scheme } = useTheme()
  useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true })
    return () => sub.remove()
  }, [open, onClose])
  return (
    <Portal>
      {open && (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          <Animated.View entering={FadeIn.duration(duration.fast)} exiting={FadeOut.duration(duration.quick)} style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
          </Animated.View>
          <Animated.View entering={modalIn} exiting={modalOut} style={[{ width: '100%', maxWidth: 380, borderRadius: radius.xl }, elevation(scheme, 2)]}>
            <Squircle accessibilityViewIsModal style={{ borderRadius: radius.xl, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 20, gap: 8 }}>
              <Text variant="headline" accessibilityRole="header">{title}</Text>
              {body && <Text variant="body" color="ink2">{body}</Text>}
              {children}
              {actions && <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>{actions}</View>}
            </Squircle>
          </Animated.View>
        </View>
      )}
    </Portal>
  )
}

// ------------------------------------------------------------------ confirm()

interface ConfirmOpts { title: string; body?: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean }
let pending: (ConfirmOpts & { resolve: (ok: boolean) => void }) | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** `if (await confirm({ title: 'Delete Dev?', confirmLabel: 'Delete teammate', destructive: true }))`. Needs <ConfirmHost/>. */
export function confirm(opts: ConfirmOpts): Promise<boolean> {
  pending?.resolve(false)
  return new Promise((resolve) => { pending = { ...opts, resolve }; emit() })
}

export function ConfirmHost() {
  const p = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => pending, () => pending)
  const [last, setLast] = useState<ConfirmOpts | null>(null)
  useEffect(() => { if (p) setLast(p) }, [p])
  const done = (ok: boolean) => { p?.resolve(ok); pending = null; emit() }
  const o = p ?? last
  if (!o) return null
  return (
    <Dialog
      open={!!p}
      onClose={() => done(false)}
      title={o.title}
      body={o.body}
      actions={<>
        <Button variant="ghost" label={o.cancelLabel ?? 'Cancel'} onPress={() => done(false)} />
        <Button variant={o.destructive ? 'destructive' : 'solid'} label={o.confirmLabel} onPress={() => done(true)} haptic={o.destructive ? 'warning' : 'light'} />
      </>}
    />
  )
}
