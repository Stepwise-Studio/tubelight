// Port of Stepwise UI's Chip (ui.stepwise.studio/r/chip.json): capsule, three variants, six colours, three sizes.
import { View } from 'react-native'

import { fonts, useTheme } from '@/theme'

import { Icon, type IconSvgElement } from './icon'
import { Press } from './press'
import { Text } from './text'

export type ChipColor = 'danger' | 'warning' | 'success' | 'info' | 'magical' | 'idle'
export type ChipVariant = 'outline' | 'soft' | 'solid'
export type ChipSize = 'sm' | 'default' | 'lg'

// Heights are the web chip's padding + trimmed cap height + border; `soft` = a lone-text soft chip (taller, per Figma).
const sizes = {
  sm: { h: 22, soft: 26, px: 10, dotLeft: 8, iconLeft: 8, font: 11, icon: 14, gap: 3, dotGap: 5, iconGap: 4, dot: 5 },
  default: { h: 28, soft: 32, px: 12, dotLeft: 10, iconLeft: 10, font: 14, icon: 18, gap: 4, dotGap: 8, iconGap: 6, dot: 6 },
  lg: { h: 32, soft: 36, px: 14, dotLeft: 11, iconLeft: 11, font: 15, icon: 20, gap: 5, dotGap: 9, iconGap: 6, dot: 6 },
} as const

const a = (hex: string, o: number) => hex + Math.round(o * 255).toString(16).padStart(2, '0')
type Pair = readonly [light: string, dark: string]
interface ColorDef { text: Pair; soft: Pair; softBorder: Pair; solid: Pair; solidText: Pair; solidBorder: Pair; outlineBorder: Pair; dot: Pair }
const white: Pair = ['#ffffff', '#ffffff']

// Tailwind values from the Stepwise source (rose / amber / green / sky / indigo / zinc).
const colors: Record<ChipColor, ColorDef> = {
  danger: {
    text: ['#e11d48', '#f43f5e'], soft: ['#fff1f2', a('#f43f5e', 0.07)], softBorder: [a('#f43f5e', 0.1), a('#fb7185', 0.1)],
    solid: ['#f43f5e', '#e11d48'], solidText: white, solidBorder: [a('#e11d48', 0.4), a('#e11d48', 0.4)],
    outlineBorder: ['#fecdd3', a('#9f1239', 0.6)], dot: ['#f43f5e', '#f43f5e'],
  },
  warning: {
    text: ['#d97706', '#f59e0b'], soft: ['#fffbeb', a('#f59e0b', 0.07)], softBorder: [a('#f59e0b', 0.15), a('#fbbf24', 0.1)],
    solid: ['#fbbf24', '#f59e0b'], solidText: white, solidBorder: [a('#f59e0b', 0.5), a('#f59e0b', 0.5)],
    outlineBorder: ['#fde68a', a('#f59e0b', 0.4)], dot: ['#f59e0b', '#f59e0b'],
  },
  success: {
    text: ['#16a34a', '#22c55e'], soft: ['#f0fdf4', a('#22c55e', 0.07)], softBorder: [a('#22c55e', 0.1), a('#4ade80', 0.1)],
    solid: ['#22c55e', a('#16a34a', 0.95)], solidText: white, solidBorder: [a('#16a34a', 0.4), a('#16a34a', 0.4)],
    outlineBorder: ['#bbf7d0', a('#166534', 0.6)], dot: ['#22c55e', '#22c55e'],
  },
  info: {
    text: ['#0284c7', '#0ea5e9'], soft: ['#f0f9ff', a('#0ea5e9', 0.07)], softBorder: [a('#0ea5e9', 0.1), a('#38bdf8', 0.1)],
    solid: ['#0ea5e9', '#0284c7'], solidText: white, solidBorder: [a('#0284c7', 0.4), a('#0284c7', 0.4)],
    outlineBorder: ['#bae6fd', a('#0369a1', 0.6)], dot: ['#0ea5e9', '#0ea5e9'],
  },
  magical: {
    text: ['#4f46e5', '#818cf8'], soft: ['#eef2ff', a('#6366f1', 0.09)], softBorder: [a('#6366f1', 0.1), a('#818cf8', 0.1)],
    solid: ['#6366f1', '#4f46e5'], solidText: white, solidBorder: [a('#4f46e5', 0.4), a('#4f46e5', 0.4)],
    outlineBorder: ['#c7d2fe', a('#4338ca', 0.6)], dot: ['#6366f1', '#6366f1'],
  },
  idle: {
    text: ['#52525b', '#d4d4d8'], soft: ['#f4f4f5', a('#27272a', 0.3)], softBorder: ['#e4e4e7', '#3f3f46'],
    solid: ['#27272a', '#e4e4e7'], solidText: ['#ffffff', '#18181b'], solidBorder: [a('#18181b', 0.1), a('#ffffff', 0.1)],
    outlineBorder: ['#e4e4e7', '#3f3f46'], dot: ['#a1a1aa', '#71717a'],
  },
}

export interface ChipProps {
  label: string
  color?: ChipColor
  variant?: ChipVariant
  size?: ChipSize
  icon?: IconSvgElement
  /** Leading status dot: only the dot takes the colour, the body stays neutral ("Connected", "Live"). */
  dot?: boolean
  /** Filter chips: selected reads as a soft info chip. */
  selected?: boolean
  onPress?: () => void
  accessibilityLabel?: string
}

/** Status or filter capsule (Stepwise UI Chip). Pressable when `onPress` is set. */
export function Chip({ label, color = 'idle', variant = 'outline', size = 'default', icon, dot, selected, onPress, accessibilityLabel }: ChipProps) {
  const { scheme } = useTheme()
  const d = scheme === 'dark' ? 1 : 0
  if (selected) { color = 'info'; variant = 'soft' }
  const s = sizes[size]
  const c = colors[color]
  const body = dot ? colors.idle : c // dot chips: only the dot is coloured
  const h = variant === 'soft' && !icon && !dot ? s.soft : s.h
  const ink = variant === 'solid' ? body.solidText[d] : body.text[d]
  const box = {
    height: h,
    borderRadius: h / 2,
    borderWidth: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingLeft: dot ? s.dotLeft : icon ? s.iconLeft : s.px,
    paddingRight: s.px,
    gap: dot ? s.dotGap : icon ? s.iconGap : s.gap,
    backgroundColor: variant === 'solid' ? body.solid[d] : variant === 'soft' ? body.soft[d] : 'transparent',
    borderColor: variant === 'solid' ? body.solidBorder[d] : variant === 'soft' ? body.softBorder[d] : body.outlineBorder[d],
  }
  const content = (
    <>
      {dot && <View style={{ width: s.dot, height: s.dot, borderRadius: s.dot, backgroundColor: variant === 'solid' ? 'rgba(255,255,255,0.85)' : c.dot[d] }} />}
      {icon && <Icon icon={icon} size={s.icon} color={ink} />}
      <Text
        numberOfLines={1}
        style={{
          fontFamily: variant === 'outline' ? fonts.regular : fonts.medium, fontSize: s.font, lineHeight: s.font + 4,
          letterSpacing: -0.42, color: ink, includeFontPadding: false,
        }}
      >
        {label}
      </Text>
    </>
  )
  if (!onPress) return <View style={[box, { alignSelf: 'flex-start' }]}>{content}</View>
  return (
    <Press
      radius={h / 2}
      smoothing={0}
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected }}
      outerStyle={{ alignSelf: 'flex-start' }}
      style={box}
    >
      {content}
    </Press>
  )
}
