// Navigation: a floating capsule of three pinned places with a pill that slides to the current one. The current
// place carries a small up/down mark; tapping it again opens every place in a Stepwise dropdown that grows out of
// it (edit the pins there). A round create button sits beside the capsule.
// The menu is mounted only while open and uses entering/exiting animations, so its rendered state is its resting
// state (release builds need that: see CLAUDE.md's Reanimated note).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import {
  BubbleChatIcon, CheckListIcon, FolderAddIcon, InboxIcon, PencilEdit02Icon, PinIcon, RepeatIcon,
  Stamp01Icon, UnfoldMoreIcon, UserAdd01Icon, UserCircleIcon, UserGroupIcon, VaultIcon, WorkHistoryIcon,
} from '@hugeicons/core-free-icons'

import { openSheet } from '@/components/sheet-screen'
import { addMenu } from '@/components/vault/browser'
import { isUnread } from '@/lib/format'
import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Badge, Icon, ListRow, Press, Sheet, Squircle, TeammateAvatar, Text, elevation, haptic, showMenu, toast, type IconSvgElement } from '@/ui'

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const BAR = 64
const GAP = 10
const SLOT = 56
const MARK = 16 // the up/down mark beside the current place's icon
const ROW = 44
const MENU_W = 228
const KEY = 'tl.nav.pinned'
const DEFAULT_PINS = ['index', 'tasks', 'vault']

/** Every place, in menu order. Tabs by route name; the rest are pages. */
const PLACES: { name: string; label: string; icon: IconSvgElement; href?: '/automations' }[] = [
  { name: 'index', label: 'Inbox', icon: InboxIcon },
  { name: 'tasks', label: 'Tasks', icon: CheckListIcon },
  { name: 'vault', label: 'Vault', icon: VaultIcon },
  { name: 'approvals', label: 'Approvals', icon: Stamp01Icon },
  { name: 'activity', label: 'Activity', icon: WorkHistoryIcon },
  { name: 'automations', label: 'Automations', icon: RepeatIcon, href: '/automations' },
  { name: 'profile', label: 'Profile', icon: UserCircleIcon },
]
const MENU_H = 6 + 36 + PLACES.length * ROW + 6

/** Space a scrolling tab screen must leave under its content for the floating bar. */
export function useTabBarInset() {
  return BAR + GAP + Math.max(useSafeAreaInsets().bottom, 12)
}

const ease = motion.ease.smoothOut

export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { width: screen } = useWindowDimensions()
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [pins, setPins] = useState<string[]>(DEFAULT_PINS)
  const [picker, setPicker] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => { const p = v ? JSON.parse(v) : null; if (Array.isArray(p) && p.length) setPins(p) }, () => {})
  }, [])
  useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setOpen(false); setEditing(false); return true })
    return () => sub.remove()
  }, [open])

  const current = state.routes[state.index]?.name
  const unread = ws.threads.some(isUnread)
  const waiting = ws.pendingApprovals.length
  const badge = (name: string) => (name === 'approvals' ? waiting : 0)
  const dot = (name: string) => name === 'index' && unread

  const close = () => { setOpen(false); setEditing(false) }
  const go = (p: (typeof PLACES)[number]) => {
    close()
    if (p.href) { haptic.tap(); router.push(p.href); return }
    if (p.name === current) return
    const route = state.routes.find((r) => r.name === p.name)
    if (!route) return
    haptic.tap()
    const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
    if (!e.defaultPrevented) navigation.navigate(p.name)
  }
  const togglePin = (name: string) => {
    haptic.tap()
    let next = pins.includes(name) ? pins.filter((n) => n !== name) : [...pins, name]
    if (!next.length) { toast({ title: 'Keep at least one in the bar' }); return }
    if (next.length > 3) next = next.slice(-3) // the oldest pin makes room
    setPins(next)
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
  }

  // The bar: the pins, plus where you are when that isn't pinned.
  const shown = PLACES.filter((p) => pins.includes(p.name) && !p.href)
  const here = PLACES.find((p) => p.name === current)
  if (here && !shown.includes(here)) shown.push(here)
  // Slots narrow a little when a fourth icon joins, so the create button always fits beside the capsule.
  const slot = Math.min(SLOT, Math.floor((screen - 32 - BAR - 12 - 12 - MARK) / shown.length))
  const width = 12 + shown.length * slot + MARK
  const at = Math.max(0, shown.findIndex((p) => p.name === current))
  const hidden = PLACES.some((p) => !shown.includes(p) && (badge(p.name) || dot(p.name)))

  // The pill: placed without animation the first time, then slides (transitions.dev tabs sliding, 250ms).
  const [placed, setPlaced] = useState(false)
  useEffect(() => { const t = requestAnimationFrame(() => setPlaced(true)); return () => cancelAnimationFrame(t) }, [])
  const pillX = 6 + at * slot
  const pill = useAnimatedStyle(() => ({
    width: placed ? withTiming(slot + MARK, { duration: motion.duration.fast, easing: ease }) : slot + MARK,
    transform: [{ translateX: placed ? withTiming(pillX, { duration: motion.duration.fast, easing: ease }) : pillX }],
  }), [pillX, slot, placed])

  const create = () => {
    haptic.tap()
    showMenu({
      title: 'New',
      items: [
        { label: 'To-do', icon: CheckListIcon, onPress: () => router.push({ pathname: '/todo/[id]', params: { id: 'new' } }) },
        { label: 'Add to Vault', icon: FolderAddIcon, onPress: () => addMenu('') },
        ...(ws.teammates.length ? [{ label: 'Message a teammate', icon: BubbleChatIcon, onPress: () => setPicker(true) }] : []),
        { label: 'Project', icon: UserGroupIcon, onPress: () => openSheet('project') },
        { label: 'Teammate', icon: UserAdd01Icon, onPress: () => openSheet('teammate') },
      ],
    })
  }

  // The menu grows out of the current place (Stepwise dropdown: scale from the trigger, 360ms smooth out).
  const originX = pillX + (slot + MARK) / 2
  const grow = () => {
    'worklet'
    return {
      initialValues: { opacity: 0, transform: [{ scale: 0.3 }] },
      animations: {
        opacity: withTiming(1, { duration: 180, easing: ease }),
        transform: [{ scale: withTiming(1, { duration: 360, easing: ease }) }],
      },
    }
  }
  const shrink = () => {
    'worklet'
    return {
      initialValues: { opacity: 1, transform: [{ scale: 1 }] },
      animations: {
        opacity: withTiming(0, { duration: 140, easing: ease }),
        transform: [{ scale: withTiming(0.97, { duration: 140, easing: ease }) }],
      },
    }
  }

  return (
    <>
      {open && <Pressable style={[StyleSheet.absoluteFill, { zIndex: 1 }]} onPress={close} accessibilityLabel="Close the menu" />}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12), zIndex: 2, flexDirection: 'row', alignItems: 'flex-end' }}>
        <View style={{ width }}>
          {/* The capsule */}
          <Animated.View layout={LinearTransition.duration(motion.duration.fast).easing(ease)} style={[{ borderRadius: BAR / 2 }, elevation(scheme)]}>
            <Squircle style={{ height: BAR, borderRadius: BAR / 2, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}
              accessibilityRole="tablist">
              <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 6, bottom: 6, borderRadius: 26, backgroundColor: c.tubeSoft }, pill]} />
              {shown.map((p) => {
                const on = current === p.name
                return (
                  <Animated.View key={p.name} layout={LinearTransition.duration(motion.duration.fast).easing(ease)}
                    entering={FadeIn.duration(motion.duration.quick)} exiting={FadeOut.duration(motion.duration.micro)}>
                    <Pressable onPress={() => (on ? (haptic.light(), setOpen(true)) : go(p))}
                      onLongPress={() => { haptic.light(); setOpen(true) }}
                      accessibilityRole="tab" accessibilityState={{ selected: on }}
                      accessibilityLabel={badge(p.name) ? `${p.label}, ${badge(p.name)} waiting` : p.label}
                      accessibilityHint={on ? 'Opens every place' : undefined}
                      style={{ width: on ? slot + MARK : slot, height: BAR - 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                      <Icon icon={p.icon} size={24} color={on ? 'tube' : 'ink3'} strokeWidth={on ? 2 : 1.6} />
                      {on && (
                        <Animated.View entering={FadeIn.duration(motion.duration.fast).delay(80)} exiting={FadeOut.duration(motion.duration.micro)} style={{ marginLeft: 2 }}>
                          <Icon icon={UnfoldMoreIcon} size={14} color="tube" strokeWidth={2} />
                          <Marker dot={hidden} small />
                        </Animated.View>
                      )}
                      <Marker count={on ? 0 : badge(p.name)} dot={!on && dot(p.name)} />
                    </Pressable>
                  </Animated.View>
                )
              })}
            </Squircle>
          </Animated.View>

          {/* Every place: a Stepwise dropdown above the bar, grown out of the current place */}
          {open && (
            <Animated.View entering={grow} exiting={shrink}
              style={[{ position: 'absolute', left: 0, bottom: BAR + 8, width: MENU_W, borderRadius: 20, transformOrigin: [originX, MENU_H, 0] }, elevation(scheme)]}>
              <Squircle style={{ borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', height: 36, paddingLeft: 10 }}>
                  <Text variant="label" color="ink3" style={{ flex: 1, fontWeight: '600' }}>{editing ? 'Pin up to 3' : 'Go to'}</Text>
                  <Press radius={12} onPress={() => { haptic.tap(); setEditing((v) => !v) }}
                    accessibilityLabel={editing ? 'Done choosing' : 'Choose what’s in the bar'}
                    style={{ height: 30, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: editing ? c.tubeSoft : undefined }}>
                    <Icon icon={PinIcon} size={14} color={editing ? 'tube' : 'ink3'} strokeWidth={1.8} />
                    <Text variant="footnote" color={editing ? 'tube' : 'ink3'} style={{ fontWeight: '600' }}>{editing ? 'Done' : 'Edit'}</Text>
                  </Press>
                </View>
                {PLACES.map((p) => {
                  const on = current === p.name
                  const pinned = pins.includes(p.name)
                  return (
                    <Press key={p.name} radius={12} onPress={() => (editing ? (p.href ? undefined : togglePin(p.name)) : go(p))} disabled={editing && !!p.href}
                      accessibilityLabel={editing ? `${pinned ? 'Unpin' : 'Pin'} ${p.label}` : p.label}
                      style={{ height: ROW, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 10, backgroundColor: on && !editing ? c.panel2 : undefined, opacity: editing && p.href ? 0.4 : 1 }}>
                      <Icon icon={p.icon} size={20} color={on ? 'ink' : 'ink2'} strokeWidth={on ? 1.9 : 1.6} />
                      <Text variant="bodyMedium" color={on ? 'ink' : 'ink2'} style={{ flex: 1 }}>{p.label}</Text>
                      {editing ? (!p.href && <Icon icon={PinIcon} size={16} color={pinned ? 'tube' : 'ink4'} strokeWidth={pinned ? 2.2 : 1.5} />)
                        : badge(p.name) ? <Badge count={badge(p.name)} /> : dot(p.name) ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.tube }} /> : null}
                    </Press>
                  )
                })}
              </Squircle>
            </Animated.View>
          )}
        </View>
        <View style={{ flex: 1 }} />
        <View style={[{ borderRadius: BAR / 2 }, elevation(scheme)]}>
          <Press radius={BAR / 2} smoothing={0} onPress={create} accessibilityLabel="New"
            style={{ width: BAR, height: BAR, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
            <Icon icon={PencilEdit02Icon} size={24} color="ink" strokeWidth={1.8} />
          </Press>
        </View>
      </View>

      <Sheet open={picker} onClose={() => setPicker(false)} title="Message a teammate">
        <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          {ws.teammates.map((t) => (
            <ListRow key={t.id} title={t.name} subtitle={t.role}
              leading={<TeammateAvatar teammate={t} size={40} interactive={false} state={ws.isWorking(t.id) ? 'working' : 'default'} />}
              onPress={() => { setPicker(false); router.push({ pathname: '/chat/[threadId]', params: { threadId: `dm:${t.id}` } }) }} />
          ))}
        </View>
      </Sheet>
    </>
  )
}

/** A count (approvals) or a dot (something new) on a bar icon. */
function Marker({ count = 0, dot, small }: { count?: number; dot?: boolean; small?: boolean }) {
  const { c } = useTheme()
  if (count) return <View style={{ position: 'absolute', top: 6, right: 6 }}><Badge count={count} /></View>
  if (!dot) return null
  const s = small ? 7 : 9
  return <View style={{ position: 'absolute', top: small ? -3 : 10, right: small ? -3 : 12, width: s, height: s, borderRadius: s / 2, backgroundColor: c.tube, borderWidth: 1.5, borderColor: c.panel }} />
}

