import { useEffect, useSyncExternalStore } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Keyframe, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Alert02Icon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons'

import { motion, radius, useTheme } from '@/theme'

import { Icon } from './icon'
import { elevation } from './surface'
import { Press } from './press'
import { Squircle } from './squircle'
import { Text } from './text'

const { duration, ease, distance } = motion

export interface ToastOpts {
  title: string
  body?: string
  tone?: 'neutral' | 'success' | 'error'
  action?: { label: string; onPress: () => void }
}
interface Item extends ToastOpts { id: number }

let queue: Item[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Queue a toast. Plain ones leave after 4s; errors and ones with an action stay until dismissed. */
export function toast(opts: ToastOpts) {
  queue = [...queue, { ...opts, id: ++seq }]
  emit()
}
const dismiss = (id: number) => { queue = queue.filter((t) => t.id !== id); emit() }

// Enter: 8px drop + fade, 250ms. Exit is quicker and quieter: 150ms.
const toastIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -distance.base }, { scale: motion.scale.medium }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: ease.smoothOut },
}).duration(duration.fast)
const toastOut = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: -distance.base }], easing: ease.smoothOut },
}).duration(duration.quick)

/** Mount once at the root. Shows the head of the queue at the top, swipe up or sideways to dismiss. */
export function ToastHost() {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => queue, () => queue)
  const insets = useSafeAreaInsets()
  const head = list[0]
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, alignItems: 'center' }}>
      {head && <ToastCard key={head.id} item={head} />}
    </View>
  )
}

function ToastCard({ item }: { item: Item }) {
  const { c, scheme } = useTheme()
  const sticky = item.tone === 'error' || !!item.action
  const x = useSharedValue(0)
  const y = useSharedValue(0)

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(item.body ? `${item.title}. ${item.body}` : item.title)
    if (sticky) return
    const t = setTimeout(() => dismiss(item.id), 4000)
    return () => clearTimeout(t)
  }, [item, sticky])

  const pan = Gesture.Pan()
    .onUpdate((e) => { x.value = e.translationX; y.value = Math.min(0, e.translationY) })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > 80 || e.translationY < -30 || Math.abs(e.velocityX) > 800) runOnJS(dismiss)(item.id)
      else { x.value = withSpring(0, motion.spring); y.value = withSpring(0, motion.spring) }
    })
  const drag = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
    opacity: 1 - Math.min(Math.abs(x.value) / 240, 0.6),
  }))

  const icon = item.tone === 'error' ? Alert02Icon : item.tone === 'success' ? CheckmarkCircle02Icon : null
  return (
    <GestureDetector gesture={pan}>
      <Animated.View entering={toastIn} exiting={toastOut} style={[{ width: '100%', maxWidth: 440, borderRadius: radius.xl }, elevation(scheme, 2), drag]}>
        <Squircle
          accessibilityRole={item.tone === 'error' ? 'alert' : 'summary'}
          style={{ borderRadius: radius.xl, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingLeft: 14, paddingRight: item.action ? 8 : 14 }}
        >
          {icon && <Icon icon={icon} size={18} color={item.tone === 'error' ? 'danger' : 'success'} />}
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" numberOfLines={2}>{item.title}</Text>
            {item.body && <Text variant="caption" color="ink3" numberOfLines={3}>{item.body}</Text>}
          </View>
          {item.action ? (
            <Press radius={14} onPress={() => { dismiss(item.id); item.action!.onPress() }} style={{ height: 36, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: c.panel2 }}>
              <Text variant="label">{item.action.label}</Text>
            </Press>
          ) : sticky ? (
            <Press radius={14} accessibilityLabel="Dismiss" onPress={() => dismiss(item.id)} style={{ height: 36, paddingHorizontal: 10, justifyContent: 'center' }}>
              <Text variant="label" color="ink3">Dismiss</Text>
            </Press>
          ) : null}
        </Squircle>
      </Animated.View>
    </GestureDetector>
  )
}
