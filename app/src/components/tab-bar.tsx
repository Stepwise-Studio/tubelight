// Navigation, Linear's way: a compact capsule with three pinned places and an up/down button that grows the capsule
// into the full menu (every place, badges, the current one lit); the sliders button picks what's pinned. A round
// create button sits beside it (new to-do, add to the Vault, message a teammate, new project or teammate).
// The menu is mounted only while open and grows/shrinks with entering/exiting animations (its rendered state is its
// resting state, which release builds need: see CLAUDE.md's Reanimated note).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition, withTiming, type EntryAnimationsValues, type ExitAnimationsValues } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import {
  BubbleChatIcon, CheckListIcon, FolderAddIcon, InboxIcon, PencilEdit02Icon, PinIcon, RepeatIcon,
  SlidersHorizontalIcon, Stamp01Icon, UnfoldMoreIcon, UserAdd01Icon, UserCircleIcon, UserGroupIcon, VaultIcon, WorkHistoryIcon,
} from '@hugeicons/core-free-icons'

import { openSheet } from '@/components/sheet-screen'
import { addMenu } from '@/components/vault/browser'
import { isUnread } from '@/lib/format'
import { useSession } from '@/lib/session'
import { useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import { Badge, Icon, ListRow, Press, Sheet, Squircle, TeammateAvatar, Text, elevation, haptic, showMenu, toast, type IconSvgElement } from '@/ui'

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const BAR = 64
const GAP = 10
const SLOT = 60
const ROW = 50
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
const MENU_H = 16 + 52 + 17 + PLACES.length * ROW + 12

/** Space a scrolling tab screen must leave under its content for the floating bar. */
export function useTabBarInset() {
  return BAR + GAP + Math.max(useSafeAreaInsets().bottom, 12)
}

/** The capsule grows into the menu from its own corner, and folds back into it. */
function grow(values: EntryAnimationsValues) {
  'worklet'
  const cfg = { duration: motion.duration.fast, easing: motion.ease.smoothOut }
  return {
    initialValues: { height: BAR, opacity: 0.4 },
    animations: { height: withTiming(values.targetHeight, cfg), opacity: withTiming(1, { duration: motion.duration.quick }) },
  }
}
function fold(values: ExitAnimationsValues) {
  'worklet'
  const cfg = { duration: motion.duration.quick + 50, easing: motion.ease.smoothOut }
  return {
    initialValues: { height: values.currentHeight, opacity: 1 },
    animations: { height: withTiming(BAR, cfg), opacity: withTiming(0, cfg) },
  }
}

export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { c, scheme } = useTheme()
  const insets = useSafeAreaInsets()
  const { width: screen } = useWindowDimensions()
  const ws = useWorkspace()
  const { session } = useSession()
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
    haptic.tap()
    close()
    if (p.href) { router.push(p.href); return }
    const route = state.routes.find((r) => r.name === p.name)
    if (!route) return
    const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
    if (current !== p.name && !e.defaultPrevented) navigation.navigate(p.name)
  }
  const togglePin = (name: string) => {
    haptic.tap()
    let next = pins.includes(name) ? pins.filter((n) => n !== name) : [...pins, name]
    if (!next.length) { toast({ title: 'Keep at least one in the bar' }); return }
    if (next.length > 3) next = next.slice(-3) // the oldest pin makes room
    setPins(next)
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
  }

  // The bar: the pins, plus where you are when that isn't pinned, then the up/down button.
  const shown = PLACES.filter((p) => pins.includes(p.name) && !p.href)
  const here = PLACES.find((p) => p.name === current)
  if (here && !shown.includes(here)) shown.push(here)
  // Slots narrow a little when a fifth icon joins, so the create button always fits beside the capsule.
  const slot = Math.min(SLOT, Math.floor((screen - 32 - BAR - 12 - 12) / (shown.length + 1)))
  const width = 12 + (shown.length + 1) * slot
  const hidden = PLACES.some((p) => !shown.includes(p) && (badge(p.name) || dot(p.name)))

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

  const me = session?.user.user_metadata?.full_name || session?.user.email?.split('@')[0] || 'You'

  return (
    <>
      {open && <Pressable style={[StyleSheet.absoluteFill, { zIndex: 1 }]} onPress={close} accessibilityLabel="Close the menu" />}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12), zIndex: 2, flexDirection: 'row', alignItems: 'flex-end' }}>
        <View style={{ width }}>
          {/* The capsule */}
          <Animated.View layout={LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)}
            style={[{ borderRadius: BAR / 2 }, elevation(scheme)]}>
            <Squircle style={{ height: BAR, borderRadius: BAR / 2, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}
              accessibilityRole="tablist">
              {shown.map((p) => {
                const on = current === p.name
                return (
                  <Animated.View key={p.name} entering={FadeIn.duration(motion.duration.quick)} exiting={FadeOut.duration(motion.duration.micro)}>
                    <Press radius={26} smoothing={0} onPress={() => go(p)} accessibilityRole="tab" accessibilityState={{ selected: on }}
                      accessibilityLabel={badge(p.name) ? `${p.label}, ${badge(p.name)} waiting` : p.label}
                      style={{ width: slot, height: BAR - 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.panel2 : undefined }}>
                      <Icon icon={p.icon} size={24} color={on ? 'ink' : 'ink3'} strokeWidth={on ? 2 : 1.6} />
                      <Marker count={badge(p.name)} dot={dot(p.name)} />
                    </Press>
                  </Animated.View>
                )
              })}
              <Press radius={26} smoothing={0} onPress={() => { haptic.light(); setOpen(true) }} accessibilityLabel="All places" accessibilityHint="Opens the menu"
                style={{ width: slot, height: BAR - 12, alignItems: 'center', justifyContent: 'center' }}>
                <Icon icon={UnfoldMoreIcon} size={24} color="ink3" strokeWidth={1.6} />
                <Marker dot={hidden} />
              </Press>
            </Squircle>
          </Animated.View>

          {/* The menu, grown out of the capsule */}
          {open && (
            <Animated.View entering={grow} exiting={fold}
              style={[{ position: 'absolute', left: 0, bottom: 0, width: Math.max(width, 268), height: MENU_H, borderRadius: 34, overflow: 'hidden' }, elevation(scheme)]}>
              <Squircle style={{ flex: 1, borderRadius: 34, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, justifyContent: 'flex-end', padding: 8, paddingTop: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 2, height: 52 }}>
                  <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.tube, alignItems: 'center', justifyContent: 'center' }}>
                    <Text variant="label" color={c.onTube}>{me.slice(0, 1).toUpperCase()}</Text>
                  </View>
                  <Text variant="headline" numberOfLines={1} style={{ flex: 1, marginLeft: 10 }}>{editing ? 'Pin up to 3' : me}</Text>
                  <Press radius={22} smoothing={0} onPress={() => { haptic.tap(); setEditing((v) => !v) }}
                    accessibilityLabel={editing ? 'Done choosing' : 'Choose what’s in the bar'}
                    style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: editing ? c.tubeSoft : c.panel2 }}>
                    <Icon icon={SlidersHorizontalIcon} size={20} color={editing ? 'tube' : 'ink2'} />
                  </Press>
                </View>
                <View style={{ height: 1, backgroundColor: c.line, marginHorizontal: 12, marginVertical: 8 }} />
                {PLACES.map((p, i) => {
                  const on = current === p.name
                  const pinned = pins.includes(p.name)
                  return (
                    <Animated.View key={p.name} entering={FadeIn.duration(motion.duration.fast).delay(40 + i * 18)}>
                      <Press radius={18} onPress={() => (editing ? (p.href ? undefined : togglePin(p.name)) : go(p))} disabled={editing && !!p.href}
                        accessibilityLabel={editing ? `${pinned ? 'Unpin' : 'Pin'} ${p.label}` : p.label}
                        style={{ height: ROW, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12, backgroundColor: on && !editing ? c.panel2 : undefined, opacity: editing && p.href ? 0.4 : 1 }}>
                        <Icon icon={p.icon} size={22} color={on ? 'ink' : 'ink2'} strokeWidth={on ? 2 : 1.6} />
                        <Text variant="bodyMedium" style={{ flex: 1, fontSize: 16 }}>{p.label}</Text>
                        {editing ? (!p.href && <Icon icon={PinIcon} size={18} color={pinned ? 'tube' : 'ink4'} strokeWidth={pinned ? 2.2 : 1.5} />)
                          : badge(p.name) ? <Badge count={badge(p.name)} /> : dot(p.name) ? <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: c.tube }} /> : null}
                      </Press>
                    </Animated.View>
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
function Marker({ count = 0, dot }: { count?: number; dot?: boolean }) {
  const { c } = useTheme()
  if (count) return <View style={{ position: 'absolute', top: 6, right: 8 }}><Badge count={count} /></View>
  if (!dot) return null
  return <View style={{ position: 'absolute', top: 10, right: 14, width: 9, height: 9, borderRadius: 5, backgroundColor: c.tube, borderWidth: 1.5, borderColor: c.panel }} />
}

