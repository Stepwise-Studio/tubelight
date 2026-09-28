import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import Animated, {
  interpolate, interpolateColor, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue,
} from 'react-native-reanimated'
import { Clock01Icon } from '@hugeicons/core-free-icons'

import { fonts, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { Collapse } from './motion'
import { Press } from './press'
import { Segment } from './segment'
import { Squircle } from './squircle'
import { Text } from './text'

const ITEM_H = 36
const VISIBLE = 5
const DEG_PER_ROW = 18
const pad = (n: number) => String(n).padStart(2, '0')

export const timeText = (h: number, m: number) =>
  new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** Stepwise UI's TimePicker (ui.stepwise.studio/r/time-picker) for touch: a field like Input showing the time; tap it
 * and it opens in place into two snap drums (hour, minute) that bend like a cylinder, with a sliding AM/PM switch.
 * Value is 24 h `{ hour, minute }`. Minutes come in `step`s, but an odd minute already set (8:10) stays pickable. */
export function TimePicker({ hour, minute, onChange, step = 5, label }: {
  hour: number; minute: number; onChange: (hour: number, minute: number) => void; step?: number; label?: string
}) {
  const { c, scheme } = useTheme()
  const [open, setOpen] = useState(false)
  const pm = hour >= 12
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const hours = Array.from({ length: 12 }, (_, i) => i + 1)
  const minutes = [...new Set([...Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step), minute])].sort((a, b) => a - b)
  const setHour12 = (n: number) => onChange((n % 12) + (pm ? 12 : 0), minute)
  const border = open ? (scheme === 'dark' ? '#d4d4d8' : '#3f3f46') : 'rgba(138,138,141,0.23)'
  return (
    <View style={{ gap: 6 }}>
      {label && <Text variant="label" color={open ? 'ink' : 'ink3'} style={{ paddingLeft: 2 }}>{label}</Text>}
      <Press radius={18} static onPress={() => { haptic.tap(); setOpen((o) => !o) }}
        accessibilityLabel={`${label ?? 'Time'}, ${timeText(hour, minute)}`} accessibilityHint={open ? 'Closes the time wheels' : 'Opens the time wheels'}
        accessibilityState={{ expanded: open }}>
        <Squircle style={{ height: 44, borderRadius: 18, borderWidth: 1, borderColor: border, backgroundColor: c.panel, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 }}>
          <Icon icon={Clock01Icon} size={18} color={open ? 'ink' : 'ink3'} />
          <Text variant="bodyMedium" style={{ fontVariant: ['tabular-nums'] }}>{timeText(hour, minute)}</Text>
        </Squircle>
      </Press>
      <Collapse open={open}>
        <Squircle style={{ marginTop: 6, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(138,138,141,0.23)', backgroundColor: c.panel, padding: 14, gap: 12 }}>
          {/* The split readout: which hour and minute the drums are on. */}
          <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', gap: 6 }} importantForAccessibility="no-hide-descendants">
            <Readout text={pad(h12)} />
            <Text style={{ fontFamily: fonts.semibold, fontSize: 20, color: c.ink3, paddingBottom: 6 }}>:</Text>
            <Readout text={pad(minute)} />
            <Text variant="label" color="ink3" style={{ paddingBottom: 7, marginLeft: 4 }}>{pm ? 'PM' : 'AM'}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8 }}>
            <Drum items={hours} value={h12} onPick={setHour12} label="Hour" />
            <Drum items={minutes} value={minute} onPick={(m) => onChange(hour, m)} format={pad} label="Minute" />
          </View>
          <Segment<'am' | 'pm'>
            value={pm ? 'pm' : 'am'}
            onChange={(v) => onChange((hour % 12) + (v === 'pm' ? 12 : 0), minute)}
            accessibilityLabel="AM or PM"
            options={[{ value: 'am', label: 'AM' }, { value: 'pm', label: 'PM' }]}
          />
        </Squircle>
      </Collapse>
    </View>
  )
}

function Readout({ text }: { text: string }) {
  const { c } = useTheme()
  return (
    <View style={{ alignItems: 'center', gap: 2 }}>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.8, color: c.ink, fontVariant: ['tabular-nums'] }}>{text}</Text>
      <View style={{ height: 2, width: 30, borderRadius: 1, backgroundColor: c.tube }} />
    </View>
  )
}

/** One snap column. Native momentum scrolling, snapped to rows; each row bends away from the centre like a drum. A
 * tick of haptics as each value passes the centre. Taps on another row roll to it. */
function Drum({ items, value, onPick, format, label }: {
  items: number[]; value: number; onPick: (n: number) => void; format?: (n: number) => string; label: string
}) {
  const ref = useRef<Animated.ScrollView>(null)
  const y = useSharedValue(Math.max(0, items.indexOf(value)) * ITEM_H)
  const last = useSharedValue(Math.max(0, items.indexOf(value)))
  const idx = Math.max(0, items.indexOf(value))
  const dragging = useRef(false)

  // An outside change (AM/PM, a reset) rolls the drum to it.
  useEffect(() => {
    if (!dragging.current) ref.current?.scrollTo({ y: idx * ITEM_H, animated: true })
  }, [idx])

  const tick = () => haptic.tap()
  const settle = (off: number) => {
    const i = Math.min(items.length - 1, Math.max(0, Math.round(off / ITEM_H)))
    dragging.current = false
    if (items[i] !== value) onPick(items[i])
  }
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.value = e.contentOffset.y
      const i = Math.round(e.contentOffset.y / ITEM_H)
      if (i !== last.value) { last.value = i; runOnJS(tick)() }
    },
    onMomentumEnd: (e) => { runOnJS(settle)(e.contentOffset.y) },
  })

  return (
    <View style={{ width: 76, height: ITEM_H * VISIBLE }} accessible accessibilityRole="adjustable" accessibilityLabel={label}
      accessibilityValue={{ text: format ? format(value) : String(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        const next = items[Math.min(items.length - 1, Math.max(0, idx + (e.nativeEvent.actionName === 'increment' ? 1 : -1)))]
        if (next !== value) onPick(next)
      }}>
      <Animated.ScrollView
        ref={ref}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        nestedScrollEnabled
        contentOffset={{ x: 0, y: idx * ITEM_H }}
        onScrollBeginDrag={() => { dragging.current = true }}
        onScrollEndDrag={(e) => {
          // A slow drag lets go without momentum: settle here (a fling settles in onMomentumEnd).
          const v = e.nativeEvent.velocity?.y ?? 0
          if (Math.abs(v) < 0.05) settle(e.nativeEvent.contentOffset.y)
        }}
        contentContainerStyle={{ paddingVertical: ITEM_H * Math.floor(VISIBLE / 2) }}
      >
        {items.map((n, i) => (
          <Row key={n} i={i} y={y} text={format ? format(n) : String(n)}
            onPress={() => ref.current?.scrollTo({ y: i * ITEM_H, animated: true })} />
        ))}
      </Animated.ScrollView>
    </View>
  )
}

function Row({ i, y, text, onPress }: { i: number; y: SharedValue<number>; text: string; onPress: () => void }) {
  const { c } = useTheme()
  const style = useAnimatedStyle(() => {
    const d = i - y.value / ITEM_H
    const abs = Math.min(3, Math.abs(d))
    return {
      opacity: interpolate(abs, [0, 1, 2, 3], [1, 0.62, 0.3, 0.08]),
      transform: [{ perspective: 320 }, { rotateX: `${-Math.max(-3, Math.min(3, d)) * DEG_PER_ROW}deg` }, { scale: interpolate(abs, [0, 1], [1.35, 1], 'clamp') }],
    }
  })
  const color = useAnimatedStyle(() => ({
    color: interpolateColor(Math.min(1, Math.abs(i - y.value / ITEM_H)), [0, 1], [c.tube, c.ink3]),
  }))
  return (
    <Press radius={8} static onPress={onPress} importantForAccessibility="no" style={{ height: ITEM_H, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.Text style={[{ fontFamily: fonts.semibold, fontSize: 15, letterSpacing: -0.4, fontVariant: ['tabular-nums'] }, style, color]}>{text}</Animated.Text>
    </Press>
  )
}
