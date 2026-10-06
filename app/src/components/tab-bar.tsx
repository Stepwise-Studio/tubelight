// Navigation: a floating capsule of four places with a pill that slides to the one you're on. The first three are
// pinned; the fourth is the switchable one (it carries a small up/down mark): it shows the last other place you
// went to, tap to go there, tap again (or long-press) to open every place in a Stepwise dropdown grown out of it,
// with your picture and the edit circle for choosing the pins. A round + beside the capsule creates things.
// The menu is mounted only while open and uses entering/exiting animations, so its rendered state is its resting
// state (release builds need that: see CLAUDE.md's Reanimated note).
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Tabs } from 'expo-router'
import type { ComponentProps } from 'react'
import {
  Add01Icon, BubbleChatIcon, CircleCheckIcon, FolderAddIcon, InboxIcon, PinIcon, SlidersHorizontalIcon, Stamp01Icon,
  UnfoldMoreIcon, UserAdd01Icon, UserCircleIcon, UserGroupIcon, VaultIcon, WorkHistoryIcon, WorkflowIcon,
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
const ROW = 46
const MENU_W = 248
const KEY = 'tl.nav.pinned'
const EXTRA = 'tl.nav.extra'
const DEFAULT_PINS = ['index', 'tasks', 'vault']

/** Every place, in menu order. Tabs by route name; the rest are pages. */
const PLACES: { name: string; label: string; icon: IconSvgElement; href?: '/automations' }[] = [
  { name: 'index', label: 'Inbox', icon: InboxIcon },
  { name: 'tasks', label: 'Tasks', icon: CircleCheckIcon },
  { name: 'vault', label: 'Vault', icon: VaultIcon },
  { name: 'approvals', label: 'Approvals', icon: Stamp01Icon },
  { name: 'activity', label: 'Activity', icon: WorkHistoryIcon },
  { name: 'automations', label: 'Automations', icon: WorkflowIcon, href: '/automations' },
  { name: 'profile', label: 'Profile', icon: UserCircleIcon },
]
const MENU_H = 8 + 56 + 9 + PLACES.length * ROW + 8
const ease = motion.ease.smoothOut

/** Space a scrolling tab screen must leave under its content for the floating bar. */
export function useTabBarInset() {
  return BAR + GAP + Math.max(useSafeAreaInsets().bottom, 12)
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
  const [extra, setExtra] = useState('approvals')
  const [picker, setPicker] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    AsyncStorage.multiGet([KEY, EXTRA]).then(([[, p], [, e]]) => {
      const list = p ? JSON.parse(p) : null
      if (Array.isArray(list) && list.length === 3) setPins(list)
      if (e) setExtra(e)
      setLoaded(true)
    }, () => setLoaded(true))
  }, [])
  useEffect(() => {
    if (!open) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setOpen(false); setEditing(false); return true })
    return () => sub.remove()
  }, [open])

  const current = state.routes[state.index]?.name
  // The fourth slot follows you to any place that isn't pinned.
  const fourth = current && !pins.includes(current) && current !== extra ? current : extra
  if (fourth !== extra) setExtra(fourth) // adjusting state while rendering (React's pattern for derived state)
  useEffect(() => { if (loaded) AsyncStorage.setItem(EXTRA, extra).catch(() => {}) }, [extra, loaded])
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
    if (pins.includes(name)) { toast({ title: 'Three places stay pinned', body: 'Pin another one to replace it.' }); return }
    const next = [...pins.slice(1), name] // the oldest pin makes room
    setPins(next)
    AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {})
  }

  const slots = [...pins, fourth].map((n) => PLACES.find((p) => p.name === n)!).filter(Boolean)
  const width = screen - 32 - BAR - 12
  const slot = (width - 12) / 4
  const at = Math.max(0, slots.findIndex((p) => p.name === current))
  const hidden = PLACES.some((p) => !slots.includes(p) && (badge(p.name) || dot(p.name)))

  // The pill: placed without animation the first time, then slides (transitions.dev tabs sliding, 250ms).
  const [placed, setPlaced] = useState(false)
  useEffect(() => { const t = requestAnimationFrame(() => setPlaced(true)); return () => cancelAnimationFrame(t) }, [])
  const pillX = 6 + at * slot
  const pill = useAnimatedStyle(() => ({
    transform: [{ translateX: placed ? withTiming(pillX, { duration: motion.duration.fast, easing: ease }) : pillX }],
  }), [pillX, placed])

  const create = () => {
    haptic.tap()
    showMenu({
      title: 'New',
      items: [
        { label: 'To-do', icon: CircleCheckIcon, onPress: () => router.push({ pathname: '/todo/[id]', params: { id: 'new' } }) },
        { label: 'Add to Vault', icon: FolderAddIcon, onPress: () => addMenu('') },
        ...(ws.teammates.length ? [{ label: 'Message a teammate', icon: BubbleChatIcon, onPress: () => setPicker(true) }] : []),
        { label: 'Project', icon: UserGroupIcon, onPress: () => openSheet('project') },
        { label: 'Teammate', icon: UserAdd01Icon, onPress: () => openSheet('teammate') },
      ],
    })
  }

  // The menu grows out of the fourth slot (Stepwise dropdown: scale from the trigger, 360ms smooth out).
  const originX = 6 + 3.5 * slot
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

  const meta = session?.user.user_metadata ?? {}
  const me = meta.full_name || meta.name || session?.user.email?.split('@')[0] || 'You'
  const photo: string | undefined = meta.avatar_url || meta.picture
  const menuLeft = Math.min(Math.max(0, originX - MENU_W / 2), width - MENU_W + 6 + BAR + 12)

  return (
    <>
      {open && <Pressable style={[StyleSheet.absoluteFill, { zIndex: 1 }]} onPress={close} accessibilityLabel="Close the menu" />}
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12), zIndex: 2, flexDirection: 'row', alignItems: 'flex-end', gap: 12 }}>
        <View style={{ width }}>
          {/* The capsule */}
          <View style={[{ borderRadius: BAR / 2 }, elevation(scheme)]}>
            <Squircle style={{ height: BAR, borderRadius: BAR / 2, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}
              accessibilityRole="tablist">
              <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 6, bottom: 6, width: slot, borderRadius: 26, backgroundColor: c.tubeSoft }, pill]} />
              {slots.map((p, i) => {
                const on = current === p.name
                const switcher = i === 3
                return (
                  <Pressable key={switcher ? 'fourth' : p.name}
                    onPress={() => (switcher && on ? (haptic.light(), setOpen(true)) : go(p))}
                    onLongPress={switcher ? () => { haptic.light(); setOpen(true) } : undefined}
                    accessibilityRole="tab" accessibilityState={{ selected: on }}
                    accessibilityLabel={badge(p.name) ? `${p.label}, ${badge(p.name)} waiting` : p.label}
                    accessibilityHint={switcher ? (on ? 'Opens every place' : 'Tap again to open every place') : undefined}
                    style={{ width: slot, height: BAR - 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon icon={p.icon} size={24} color={on ? 'tube' : 'ink3'} strokeWidth={on ? 2 : 1.6} />
                    {switcher && (
                      <View style={{ marginLeft: 1 }}>
                        <Icon icon={UnfoldMoreIcon} size={13} color={on ? 'tube' : 'ink4'} strokeWidth={2} />
                        <Marker dot={hidden} small />
                      </View>
                    )}
                    <Marker count={badge(p.name)} dot={dot(p.name)} />
                  </Pressable>
                )
              })}
            </Squircle>
          </View>

          {/* Every place: a Stepwise dropdown above the bar, grown out of the fourth slot */}
          {open && (
            <Animated.View entering={grow} exiting={shrink}
              style={[{ position: 'absolute', left: menuLeft, bottom: BAR + 10, width: MENU_W, borderRadius: 22, transformOrigin: [originX - menuLeft, MENU_H, 0] }, elevation(scheme)]}>
              <Squircle style={{ borderRadius: 22, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', height: 56, paddingLeft: 6, paddingRight: 2 }}>
                  {photo ? <Image source={photo} style={{ width: 34, height: 34, borderRadius: 17 }} cachePolicy="disk" accessibilityIgnoresInvertColors />
                    : <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.tube, alignItems: 'center', justifyContent: 'center' }}>
                      <Text variant="label" color={c.onTube}>{me.slice(0, 1).toUpperCase()}</Text>
                    </View>}
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text variant="bodyMedium" numberOfLines={1}>{me}</Text>
                    <Text variant="footnote" color="ink3" numberOfLines={1}>{editing ? 'Tap a place to pin it' : 'Go to'}</Text>
                  </View>
                  <Press radius={20} smoothing={0} onPress={() => { haptic.tap(); setEditing((v) => !v) }}
                    accessibilityLabel={editing ? 'Done choosing' : 'Choose the pinned places'}
                    style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center', backgroundColor: editing ? c.tubeSoft : c.panel2, borderWidth: 1, borderColor: editing ? 'transparent' : c.line }}>
                    <Icon icon={SlidersHorizontalIcon} size={18} color={editing ? 'tube' : 'ink2'} />
                  </Press>
                </View>
                <View style={{ height: 1, backgroundColor: c.line, marginHorizontal: 6, marginVertical: 4 }} />
                {PLACES.map((p) => {
                  const on = current === p.name
                  const pinned = pins.includes(p.name)
                  return (
                    <Press key={p.name} radius={12} onPress={() => (editing ? (p.href ? undefined : togglePin(p.name)) : go(p))} disabled={editing && !!p.href}
                      accessibilityLabel={editing ? `${pinned ? 'Pinned' : 'Pin'} ${p.label}` : p.label}
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
        <View style={[{ borderRadius: BAR / 2 }, elevation(scheme)]}>
          <Press radius={BAR / 2} smoothing={0} onPress={create} accessibilityLabel="New"
            style={{ width: BAR, height: BAR, alignItems: 'center', justifyContent: 'center', backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
            <Icon icon={Add01Icon} size={26} color="ink" strokeWidth={1.8} />
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

