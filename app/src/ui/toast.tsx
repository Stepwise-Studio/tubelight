// Port of Stepwise UI's Toast (ui.stepwise.studio/r/toast.json), docked at the top for phones:
// squircle card (22), tone tint bleeding in from the top-left, filled status icon, pill action or ✕,
// and a deck: up to three stacked, the older ones peeking out below the newest.
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, Keyframe, LinearTransition, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { fonts, motion, useTheme } from '@/theme'

import { Icon } from './icon'
import { Press } from './press'
import { Squircle } from './squircle'
import { Text } from './text'

export type ToastTone = 'success' | 'warning' | 'error' | 'info'
export interface ToastOpts {
  title: string
  body?: string
  /** 'neutral' reads as info. */
  tone?: ToastTone | 'neutral'
  action?: { label: string; onPress: () => void }
  /** ms before it leaves on its own (default 5000). Toasts with an action stay until used or dismissed. */
  duration?: number
}
interface Item extends ToastOpts { id: number }

let queue: Item[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Queue a toast. It leaves after 5s unless it carries an action; swipe it away or tap ✕ any time. */
export function toast(opts: ToastOpts) {
  queue = [...queue, { ...opts, id: ++seq }]
  emit()
}
const dismiss = (id: number) => { queue = queue.filter((t) => t.id !== id); emit() }

const RADIUS = 22
const MAX_VISIBLE = 3
const PEEK = 10 // dp each older toast shows below the one in front
const INSET = 10 // dp each older toast narrows by, per side

// Only the tint and icon differ per tone (the Stepwise values).
// Tints are the Stepwise rgba values split into colour + opacity (react-native-svg ignores alpha inside a stop colour).
const TINT_OPACITY = 0.22
// Filled status marks like the iconsax Bold set Stepwise uses: a coloured shape with the glyph knocked out in white.
const TONES: Record<ToastTone, { tint: string; color: string; glyph: typeof Tick02Icon | string; square?: boolean }> = {
  success: { tint: '#4ade80', color: '#22c55e', glyph: Tick02Icon },
  warning: { tint: '#fbbf24', color: '#f59e0b', glyph: '!', square: true },
  error: { tint: '#f87171', color: '#f43f5e', glyph: Cancel01Icon },
  info: { tint: '#38bdf8', color: '#0ea5e9', glyph: 'i' },
}
const toneOf = (t: ToastOpts['tone']): ToastTone => (t && t !== 'neutral' ? t : 'info')

// Enter from above with a slight scale (Stepwise: 44px + 0.9 from its edge), leave the same way, quicker.
const toastIn = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -28 }, { scale: 0.94 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }], easing: motion.ease.smoothOut },
}).duration(300)
const toastOut = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] },
  100: { opacity: 0, transform: [{ translateY: -28 }, { scale: 0.94 }], easing: motion.ease.smoothOut },
}).duration(motion.duration.quick)

/** Mount once at the root. */
export function ToastHost() {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => queue, () => queue)
  const insets = useSafeAreaInsets()
  const [frontHeight, setFrontHeight] = useState(0)
  const deck = list.slice(-MAX_VISIBLE).reverse() // newest first
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 12, right: 12, alignItems: 'center' }}>
      <View pointerEvents="box-none" style={{ width: '100%', maxWidth: 440 }}>
        {deck.map((item, depth) => (
          <ToastCard
            key={item.id}
            item={item}
            depth={depth}
            height={frontHeight}
            onHeight={depth === 0 ? setFrontHeight : undefined}
          />
        ))}
      </View>
    </View>
  )
}

function ToastCard({ item, depth, height, onHeight }: { item: Item; depth: number; height: number; onHeight?: (h: number) => void }) {
  const { scheme } = useTheme()
  const dark = scheme === 'dark'
  const front = depth === 0
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  useEffect(() => {
    if (!front) return
    AccessibilityInfo.announceForAccessibility(item.body ? `${item.title}. ${item.body}` : item.title)
    if (item.action) return
    const t = setTimeout(() => dismiss(item.id), item.duration ?? 5000)
    return () => clearTimeout(t)
  }, [item, front])

  const pan = Gesture.Pan()
    .enabled(front)
    .onUpdate((e) => { x.value = e.translationX; y.value = Math.min(0, e.translationY) })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > 80 || e.translationY < -30 || Math.abs(e.velocityX) > 800) runOnJS(dismiss)(item.id)
      else { x.value = withSpring(0, motion.spring); y.value = withSpring(0, motion.spring) }
    })
  // Rests at 0 (its first value), so a later React commit can't snap it anywhere else.
  const drag = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
    opacity: 1 - Math.min(Math.abs(x.value) / 240, 0.6),
  }))

  // Older toasts sit behind as narrower cards peeking out below; position is layout, animated by the transition.
  const place = front
    ? { position: 'relative' as const }
    : { position: 'absolute' as const, top: PEEK * depth, left: INSET * depth, right: INSET * depth, height: height || undefined, opacity: height ? 1 : 0 }
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        entering={toastIn}
        exiting={toastOut}
        layout={LinearTransition.duration(motion.duration.fast)}
        onLayout={onHeight ? (e) => onHeight(e.nativeEvent.layout.height) : undefined}
        style={[place, { zIndex: MAX_VISIBLE - depth, borderRadius: RADIUS, boxShadow: dark ? '0 8px 24px rgba(0,0,0,0.45)' : '0 8px 24px rgba(9,9,11,0.10)' }, drag]}
        pointerEvents={front ? 'auto' : 'none'}
        importantForAccessibility={front ? 'auto' : 'no-hide-descendants'}
      >
        <Notice
          tone={toneOf(item.tone)}
          title={item.title}
          body={item.body}
          action={item.action && { label: item.action.label, onPress: () => { dismiss(item.id); item.action!.onPress() } }}
          onDismiss={() => dismiss(item.id)}
          fill={!front}
          hidden={!front}
        />
      </Animated.View>
    </GestureDetector>
  )
}

export interface NoticeProps {
  tone: ToastTone
  title: string
  body?: string
  /** A pill button on the right (Retry, Undo). */
  action?: { label: string; onPress: () => void }
  /** Without an action, a quiet ✕ that calls this. */
  onDismiss?: () => void
  /** Stretch to the parent's height (a card behind the toast deck). */
  fill?: boolean
  /** Keep the card but hide its content (the deck's back cards). */
  hidden?: boolean
  /** Show only the title, with a small "View more" that reveals the body. */
  collapsible?: boolean
}

/**
 * The Stepwise UI toast card on its own: squircle (22), the tone's tint bleeding in from the top-left corner,
 * a filled status mark, a semibold title over a grey line, and a pill action or ✕. Toasts use it, and so do
 * notices that sit inline (a failed reply in a chat).
 */
export function Notice({ tone: toneName, title, body, action, onDismiss, fill, hidden, collapsible }: NoticeProps) {
  const [open, setOpen] = useState(!collapsible)
  const { c, scheme } = useTheme()
  const dark = scheme === 'dark'
  const tone = TONES[toneName]
  const id = useId()
  const [box, setBox] = useState({ w: 0, h: 0 })
  // CSS 135°: the gradient line runs corner to corner at 45°, so it spans (w + h) / 2 on each axis.
  const span = (box.w + box.h) / 2
  return (
    <Squircle
      accessibilityRole={toneName === 'error' ? 'alert' : 'summary'}
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={{
        borderRadius: RADIUS, overflow: 'hidden', flex: fill ? 1 : undefined,
        backgroundColor: dark ? '#1c1c1f' : '#fafafa', borderWidth: 1, borderColor: dark ? 'rgba(63,63,70,0.7)' : 'rgba(212,212,216,0.7)',
      }}
    >
      {/* Sized in numbers from the card's layout: a percentage-sized Svg kept its first height when the card grew. */}
      <Svg style={{ position: 'absolute', top: 0, left: 0 }} width={box.w} height={box.h}>
        <Defs>
          <LinearGradient id={`t${id}`} x1={0} y1={0} x2={span} y2={span} gradientUnits="userSpaceOnUse">
            <Stop offset="0.04" stopColor={tone.tint} stopOpacity={TINT_OPACITY} />
            <Stop offset="0.3" stopColor={tone.tint} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        {span > 0 && <Rect width={box.w} height={box.h} fill={`url(#t${id})`} />}
      </Svg>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, opacity: hidden ? 0 : 1 }}>
        <View style={{ width: 22, height: 22, borderRadius: tone.square ? 7 : 11, backgroundColor: tone.color, alignItems: 'center', justifyContent: 'center' }}>
          {typeof tone.glyph === 'string'
            ? <Text style={{ fontFamily: fonts.bold, fontSize: 13, lineHeight: 16, color: '#ffffff', includeFontPadding: false }}>{tone.glyph}</Text>
            : <Icon icon={tone.glyph} size={13} color="#ffffff" strokeWidth={3} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text numberOfLines={2} style={{ fontFamily: fonts.semibold, fontSize: 14, lineHeight: 18, letterSpacing: -0.36, color: dark ? '#f4f4f5' : '#27272a' }}>
            {title}
          </Text>
          {body && open ? (
            <Animated.Text entering={FadeIn.duration(motion.duration.fast)} style={{ fontFamily: fonts.regular, fontSize: 14, lineHeight: 18, letterSpacing: -0.36, color: dark ? '#a1a1aa' : '#71717a' }}>
              {body}
            </Animated.Text>
          ) : null}
          {body && collapsible ? (
            <Press radius={6} static hitSlop={8} onPress={() => setOpen(!open)} accessibilityLabel={open ? 'Show less' : 'View more about this error'} outerStyle={{ alignSelf: 'flex-start' }}>
              <Text style={{ fontFamily: fonts.medium, fontSize: 12, letterSpacing: -0.2, color: dark ? '#a1a1aa' : '#71717a' }}>{open ? 'Show less' : 'View more'}</Text>
            </Press>
          ) : null}
        </View>
        {action ? (
          <Press
            radius={17}
            smoothing={0}
            onPress={action.onPress}
            style={{ height: 34, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: dark ? '#3f3f46' : '#e4e4e7' }}
          >
            <Text style={{ fontFamily: fonts.medium, fontSize: 12, letterSpacing: -0.3, color: dark ? '#f4f4f5' : '#27272a' }}>{action.label}</Text>
          </Press>
        ) : onDismiss ? (
          <Press radius={14} smoothing={0} accessibilityLabel="Dismiss" hitSlop={8} onPress={onDismiss} style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
            <Icon icon={Cancel01Icon} size={16} color={c.ink3} strokeWidth={1.5} />
          </Press>
        ) : null}
      </View>
    </Squircle>
  )
}
