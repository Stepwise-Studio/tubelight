// The alarm's time, Samsung Clock-like: big numerals on wheels (hour, minute, AM/PM) that scroll natively and snap,
// a soft band behind the picked row, the rest fading out top and bottom. A light tick on every step.
import { LinearGradient } from 'expo-linear-gradient'
import { useRef } from 'react'
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'

import { fonts, useTheme } from '@/theme'
import { Squircle, Text, haptic } from '@/ui'

const ROW = 72
const SHOWN = 3
const pad = (n: number) => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

export function ClockWheel({ hour, minute, onChange }: { hour: number; minute: number; onChange: (hour: number, minute: number) => void }) {
  const { c } = useTheme()
  const pm = hour >= 12
  const h12 = hour % 12 || 12
  const to24 = (h: number, isPm: boolean) => (h % 12) + (isPm ? 12 : 0)
  return (
    <View style={{ height: ROW * SHOWN, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
      <Squircle style={{ position: 'absolute', left: 0, right: 0, top: ROW, height: ROW, borderRadius: 22, backgroundColor: c.panel2 }} />
      <Wheel items={HOURS.map(String)} index={h12 - 1} width={92} onPick={(i) => onChange(to24(HOURS[i], pm), minute)} label="Hour" />
      <Text style={{ fontFamily: fonts.regular, fontSize: 44, lineHeight: ROW, color: c.ink3, marginTop: -6 }}>:</Text>
      <Wheel items={MINUTES.map(pad)} index={minute} width={92} onPick={(i) => onChange(hour, i)} label="Minute" />
      <Wheel items={['AM', 'PM']} index={pm ? 1 : 0} width={72} small onPick={(i) => onChange(to24(h12, i === 1), minute)} label="AM or PM" />
      <LinearGradient pointerEvents="none" colors={[c.canvas, `${c.canvas}00`]} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: ROW }} />
      <LinearGradient pointerEvents="none" colors={[`${c.canvas}00`, c.canvas]} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: ROW }} />
    </View>
  )
}

function Wheel({ items, index, width, small, onPick, label }: {
  items: string[]; index: number; width: number; small?: boolean; onPick: (i: number) => void; label: string
}) {
  const { c } = useTheme()
  const at = useRef(index)
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(0, Math.min(items.length - 1, Math.round(e.nativeEvent.contentOffset.y / ROW)))
    if (i !== index) onPick(i)
  }
  return (
    <ScrollView
      style={{ width, height: ROW * SHOWN, flexGrow: 0 }}
      contentContainerStyle={{ paddingVertical: ROW }}
      contentOffset={{ x: 0, y: index * ROW }}
      snapToInterval={ROW}
      decelerationRate="fast"
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
      scrollEventThrottle={32}
      onScroll={(e) => {
        const i = Math.round(e.nativeEvent.contentOffset.y / ROW)
        if (i !== at.current && i >= 0 && i < items.length) { at.current = i; haptic.light() }
      }}
      onMomentumScrollEnd={settle}
      onScrollEndDrag={(e) => { if (!e.nativeEvent.velocity?.y) settle(e) }}
      accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: items[index] }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onPick(Math.max(0, Math.min(items.length - 1, index + (e.nativeEvent.actionName === 'increment' ? 1 : -1))))}
    >
      {items.map((s) => (
        <View key={s} style={{ height: ROW, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontFamily: small ? fonts.medium : fonts.regular, fontSize: small ? 20 : 48, letterSpacing: small ? 0 : -1.5, color: c.ink, fontVariant: ['tabular-nums'] }}>{s}</Text>
        </View>
      ))}
    </ScrollView>
  )
}
