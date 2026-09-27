// Small building blocks shared by the teammate, project and rule editors.
import { type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated'
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { Grabber, useSheet } from '@/components/sheet-screen'
import type { Teammate } from '@/lib/types'
import { motion, radius, useTheme } from '@/theme'
import { Icon, IconButton, Press, TeammateAvatar, Text, Toggle, haptic } from '@/ui'

/** Header for a sheet route: grabber, title, optional subtitle, round close. Inside a SheetScreen it drags the sheet. */
export function SheetHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose?: () => void }) {
  const sheet = useSheet()
  const header = (
    <View collapsable={false}>
      {sheet && <Grabber />}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 12, paddingTop: sheet ? 8 : 16, paddingBottom: 8, gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text variant="heading" accessibilityRole="header">{title}</Text>
          {subtitle && <Text variant="caption" color="ink3">{subtitle}</Text>}
        </View>
        <IconButton icon={Cancel01Icon} accessibilityLabel="Close" variant="soft" round size={36} iconSize={18} onPress={sheet?.close ?? onClose} />
      </View>
    </View>
  )
  // In a sheet the header is the drag handle: pull it down to close.
  return sheet ? <GestureDetector gesture={sheet.drag}>{header}</GestureDetector> : header
}

/** A titled group of fields. Groups sit 32 apart; fields inside 16. */
export function FormSection({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, minHeight: 20 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="overline" color="ink3" accessibilityRole="header">{title}</Text>
          {hint && <Text variant="caption" color="ink3">{hint}</Text>}
        </View>
        {action}
      </View>
      {children}
    </View>
  )
}

/** Colour dots with a tube ring on the selected one. */
export function ColorSwatches({ colors, value, onChange }: { colors: { value: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  const { c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 4 }} accessibilityRole="radiogroup" accessibilityLabel="Colour">
      {colors.map((col) => {
        const on = col.value.toLowerCase() === value.toLowerCase()
        return (
          <Pressable
            key={col.value}
            accessibilityRole="radio"
            accessibilityLabel={col.name}
            accessibilityState={{ checked: on }}
            onPress={() => { if (!on) { haptic.tap(); onChange(col.value) } }}
            style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: on ? c.tube : 'transparent' }}
            hitSlop={4}
          >
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: col.value, borderWidth: 1, borderColor: c.imageOutline }} />
          </Pressable>
        )
      })}
    </View>
  )
}

/** Teammate faces you can toggle (project members, rule owner). */
export function TeammateToggles({ teammates, selected, onToggle, single }: {
  teammates: Teammate[]
  selected: Set<string>
  onToggle: (id: string) => void
  single?: boolean
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }} accessibilityRole={single ? 'radiogroup' : undefined}>
      {teammates.map((t) => <FaceToggle key={t.id} teammate={t} on={selected.has(t.id)} single={single} onPress={() => onToggle(t.id)} />)}
    </View>
  )
}

function FaceToggle({ teammate, on, single, onPress }: { teammate: Teammate; on: boolean; single?: boolean; onPress: () => void }) {
  const { c } = useTheme()
  const ring = useAnimatedStyle(() => ({
    borderColor: withTiming(on ? c.tube : 'transparent', { duration: motion.duration.quick }),
  }), [on, c])
  const check = useAnimatedStyle(() => ({
    opacity: withTiming(on ? 1 : 0, { duration: motion.duration.quick }),
    transform: [{ scale: withTiming(on ? 1 : 0.25, { duration: motion.duration.fast, easing: motion.ease.icon }) }],
  }), [on])
  return (
    <Press
      radius={radius.lg}
      onPress={() => { haptic.tap(); onPress() }}
      accessibilityRole={single ? 'radio' : 'checkbox'}
      accessibilityLabel={`${teammate.name}, ${teammate.role}`}
      accessibilityState={{ checked: on }}
      style={{ width: 76, paddingVertical: 8, alignItems: 'center', gap: 6 }}
    >
      <View>
        <Animated.View style={[{ borderRadius: 32, borderWidth: 2, padding: 3 }, ring]}>
          <TeammateAvatar teammate={teammate} size={48} interactive={false} />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: c.tube, borderWidth: 2, borderColor: c.panel, alignItems: 'center', justifyContent: 'center' }, check]}>
          <Icon icon={Tick02Icon} size={12} color={c.onTube} strokeWidth={2.5} />
        </Animated.View>
      </View>
      <Text variant="label" color={on ? 'ink' : 'ink3'} numberOfLines={1}>{teammate.name}</Text>
    </Press>
  )
}

/** A monospace block with its own copy button (webhook URLs, curl, terminal output). */
export function CodeBlock({ value, label, onCopy, tone = 'panel2' }: { value: string; label?: string; onCopy?: () => void; tone?: 'panel2' | 'terminal' }) {
  const { c, scheme } = useTheme()
  const bg = tone === 'terminal' ? (scheme === 'dark' ? '#050506' : '#18181b') : c.panel2
  const ink = tone === 'terminal' ? '#e4e4e7' : c.ink
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: bg, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
      {(label || onCopy) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4, height: 36, borderBottomWidth: 1, borderBottomColor: tone === 'terminal' ? 'rgba(255,255,255,0.08)' : c.line }}>
          <Text variant="footnote" color={tone === 'terminal' ? '#a1a1aa' : 'ink3'} style={{ flex: 1 }}>{label}</Text>
          {onCopy && (
            <Press radius={10} onPress={onCopy} accessibilityLabel={label ? `Copy ${label.toLowerCase()}` : 'Copy'} style={{ height: 32, paddingHorizontal: 10, justifyContent: 'center' }} wash={tone === 'terminal' ? 'rgba(255,255,255,0.08)' : undefined}>
              <Text variant="label" color={tone === 'terminal' ? '#e4e4e7' : 'ink2'}>Copy</Text>
            </Press>
          )}
        </View>
      )}
      <Text variant="mono" selectable style={{ color: ink, padding: 12, fontSize: 12, lineHeight: 18 }}>{value}</Text>
    </View>
  )
}

/** A row whose whole surface is one switch: tile, title, status, and the toggle as its visual. */
export function SwitchRow({ title, subtitle, leading, value, onChange, hint }: {
  title: string
  subtitle?: string
  leading?: ReactNode
  value: boolean
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <Press
      radius={radius.md}
      static
      onPress={() => { haptic.tap(); onChange(!value) }}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={hint}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 12 }}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyMedium" numberOfLines={1}>{title}</Text>
        {subtitle ? <Text variant="caption" color="ink3" numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Toggle value={value} onChange={() => {}} />
      </View>
    </Press>
  )
}

/** A tappable row with a separate trailing control, so screen readers reach both. */
export function RowWithAction({ onPress, action, children, accessibilityLabel, accessibilityHint }: {
  onPress: () => void
  action: ReactNode
  children: ReactNode
  accessibilityLabel: string
  accessibilityHint?: string
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 8 }}>
      <Press
        radius={radius.md}
        static
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        outerStyle={{ flex: 1 }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 8, paddingHorizontal: 12 }}
      >
        {children}
      </Press>
      {action}
    </View>
  )
}
