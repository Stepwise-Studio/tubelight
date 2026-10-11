// Stepwise UI's Folder (ui.stepwise.studio/docs/folder), ported to React Native: one continuous back panel with its
// tab, cards tucked inside (the folder's own photos when it has some, otherwise skeleton pages), and a frosted front
// pocket carrying an icon. A folder's colour and icon are the user's (FOLDER_COLORS / FOLDER_ICONS). Pressing it tips
// the pocket open and lifts the cards, the way the web folder opens on hover.
import { Image } from 'expo-image'
import { memo, useMemo } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'
import Svg, { Defs, Ellipse, Path, RadialGradient, Stop } from 'react-native-svg'
import {
  Book02Icon, Briefcase01Icon, Camera01Icon, CodeIcon, File01Icon, Folder01Icon, Image02Icon, Invoice01Icon, LaptopIcon,
  MusicNote01Icon, StarIcon, Video01Icon,
} from '@hugeicons/core-free-icons'

import { useTheme } from '@/theme'
import { Icon, SelectDot, Squircle, Text } from '@/ui'

/** The colours a folder can take (Stepwise's swatch set), and the neutral default. */
export const FOLDER_COLORS = [
  { value: '', name: 'Plain' }, { value: '#bfdbfe', name: 'Sky' }, { value: '#ddd6fe', name: 'Lilac' }, { value: '#2563eb', name: 'Blue' },
  { value: '#f5d98b', name: 'Sand' }, { value: '#fbcfe8', name: 'Rose' }, { value: '#bbf7d0', name: 'Mint' },
]
export const DEFAULT_COLOR = '#bfdbfe'
export const FOLDER_ICONS = {
  folder: Folder01Icon, file: File01Icon, image: Image02Icon, camera: Camera01Icon, video: Video01Icon, music: MusicNote01Icon,
  book: Book02Icon, work: Briefcase01Icon, receipt: Invoice01Icon, code: CodeIcon, star: StarIcon, laptop: LaptopIcon,
} as const
export type FolderIconName = keyof typeof FOLDER_ICONS

type Vertex = { x: number; y: number; r: number }

/** One continuous rounded path through the points (Stepwise's roundedPolygon: squircle-smoothed fillets). */
function roundedPolygon(pts: Vertex[], smoothing = 0.6) {
  const n = pts.length
  const unit = (x: number, y: number) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l } }
  const cs = pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n]
    const next = pts[(i + 1) % n]
    const inV = unit(p.x - prev.x, p.y - prev.y)
    const outV = unit(next.x - p.x, next.y - p.y)
    const phi = Math.acos(Math.max(-1, Math.min(1, inV.x * outV.x + inV.y * outV.y)))
    const flat = phi < 1e-4
    const t = flat ? 0 : p.r * Math.tan(phi / 2)
    const dC = flat ? 0 : t * (1 - (4 / 3) * Math.tan(phi / 4) / Math.tan(phi / 2))
    return { p, inV, outV, t, dC, T: t * (1 + smoothing) }
  })
  for (let i = 0; i < n; i++) {
    const a = cs[i]
    const b = cs[(i + 1) % n]
    const edge = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y)
    const need = a.T + b.T
    if (need > edge && need > 0) { const k = edge / need; a.T *= k; a.dC *= k; b.T *= k; b.dC *= k }
  }
  const d: string[] = []
  cs.forEach((c, i) => {
    const f = (v: number) => v.toFixed(2)
    d.push(`${i === 0 ? 'M' : 'L'} ${f(c.p.x - c.inV.x * c.T)} ${f(c.p.y - c.inV.y * c.T)}`)
    d.push(`C ${f(c.p.x - c.inV.x * c.dC)} ${f(c.p.y - c.inV.y * c.dC)} ${f(c.p.x + c.outV.x * c.dC)} ${f(c.p.y + c.outV.y * c.dC)} ${f(c.p.x + c.outV.x * c.T)} ${f(c.p.y + c.outV.y * c.T)}`)
  })
  return `${d.join(' ')} Z`
}

// The web folder shifts OKLCH lightness; mixing toward white or black in sRGB is close enough at these amounts.
function mix(hex: string, to: string, t: number, alpha = 1) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [a, b] = [p(hex), p(to)]
  const [r, g, bl] = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return alpha < 1 ? `rgba(${r},${g},${bl},${alpha})` : `rgb(${r},${g},${bl})`
}

const SPRING = { stiffness: 260, damping: 24 }

export const Folder = memo(function Folder({ size, label, count, color = DEFAULT_COLOR, icon = 'folder', thumbs = [], peek = 3, badge, onPress, onLongPress, selected, selecting, accessibilityLabel }: {
  size: number
  label: string
  count?: string
  /** Body colour (hex); the default is Sky, '' is Stepwise's neutral (Plain). */
  color?: string
  icon?: FolderIconName | ''
  /** Up to three photos inside it, peeking out instead of skeleton pages. */
  thumbs?: string[]
  /** How many pages peek out (0 = an empty folder). */
  peek?: number
  /** A small mark beside the count (a synced folder's computer). */
  badge?: React.ReactNode
  onPress: () => void
  onLongPress?: () => void
  selected?: boolean
  /** Choosing several: every folder shows its check circle. */
  selecting?: boolean
  accessibilityLabel?: string
}) {
  const { c, scheme } = useTheme()
  const dark = scheme === 'dark'
  const reduce = useReducedMotion()
  const open = useSharedValue(0)
  const w = size
  const h = w * 0.82
  const pocketH = h * 0.6
  const r = w * 0.08
  const back = useMemo(() => {
    const tabW = w * 0.42
    const tabH = h * 0.13
    const tabCut = tabH * 1.1
    return roundedPolygon([
      { x: 0, y: 0, r: r * 0.55 }, { x: tabW - tabCut, y: 0, r: r * 0.9 }, { x: tabW, y: tabH, r: r * 1.2 },
      { x: w, y: tabH, r }, { x: w, y: h, r }, { x: 0, y: h, r },
    ])
  }, [w, h, r])

  const tone = color
    ? { body: color, pocket: mix(color, '#ffffff', 0.22, 0.92), icon: mix(color, '#000000', 0.42), card: mix(color, '#ffffff', 0.86), accent: mix(color, '#ffffff', 0.55) }
    : dark
      ? { body: '#2c2d33', pocket: 'rgba(40,41,47,0.86)', icon: '#71717a', card: '#eceef3', accent: '#d5d8e0' }
      : { body: '#dfe1e7', pocket: 'rgba(232,234,239,0.9)', icon: '#71717a', card: '#ffffff', accent: '#e6e8ee' }
  const line = dark ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.08)'
  const strong = dark ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.16)'

  const cards = thumbs.length ? thumbs.slice(0, 3) : Array.from({ length: Math.min(peek, 3) }, () => '')
  const cardW = w * 0.56
  const cardH = h * 0.56
  const topBase = h * 0.2
  const front = cards.length - 1

  // Pressed: the pocket tips forward and the cards rise (resting state is closed, so release builds keep it).
  const pocket = useAnimatedStyle(() => ({ transform: [{ perspective: 900 }, { translateY: pocketH / 2 }, { rotateX: `${-24 * open.value}deg` }, { translateY: -pocketH / 2 }] }))
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(open.value, [0, 1], [0, -h * 0.1]) }] }))
  const press = (to: number) => { open.set(reduce ? to : withSpring(to, SPRING)) }

  const iconGlyph = icon ? FOLDER_ICONS[icon] : null
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} onPressIn={() => press(1)} onPressOut={() => press(0)} delayLongPress={380}
      accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `${label}, folder${count ? `, ${count}` : ''}`} accessibilityState={{ selected }}
      style={{ width: w, alignItems: 'center', gap: 10 }}>
      <View style={{ width: w, height: h, opacity: selecting && !selected ? 0.55 : 1, transform: [{ scale: selected ? 0.94 : 1 }] }}>
        {/* ground shadow */}
        <Svg width={w} height={h * 0.3} style={{ position: 'absolute', left: 0, bottom: -h * 0.12 }}>
          <Defs>
            <RadialGradient id="fs" cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor="#000" stopOpacity={dark ? 0.5 : 0.22} />
              <Stop offset="1" stopColor="#000" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={w / 2} cy={h * 0.15} rx={w * 0.46} ry={h * 0.09} fill="url(#fs)" />
        </Svg>
        {/* back panel and tab: one silhouette */}
        <Svg width={w} height={h} style={{ position: 'absolute' }}>
          <Path d={back} fill={tone.body} />
        </Svg>
        {/* the cards, tucked: the front one straight, the ones behind tilted out to either side */}
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, lift]} pointerEvents="none">
          {cards.map((thumb, i) => {
            const left = i % 2 === 0
            const t = i === front ? { x: 0, rot: 0 } : { x: left ? -w * 0.1 : w * 0.11, rot: left ? -5 : 5 }
            return (
              <View key={i} style={{ position: 'absolute', left: (w - cardW) / 2, top: topBase, width: cardW, height: cardH, borderRadius: w * 0.05, overflow: 'hidden',
                backgroundColor: tone.card, transform: [{ translateX: t.x }, { rotate: `${t.rot}deg` }],
                shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 3 }}>
                {thumb ? <Image source={thumb} style={{ flex: 1 }} contentFit="cover" recyclingKey={thumb} cachePolicy="disk" /> : <Skeleton accent={tone.accent} line={line} strong={strong} />}
              </View>
            )
          })}
        </Animated.View>
        {/* front pocket: frosted, carrying the icon */}
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, height: pocketH }, pocket]} pointerEvents="none">
          <Squircle style={{ flex: 1, borderRadius: r, backgroundColor: tone.pocket, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ position: 'absolute', top: 0, left: r, right: r, height: 1.5, backgroundColor: 'rgba(255,255,255,0.55)', borderRadius: 1 }} />
            {iconGlyph && <Icon icon={iconGlyph} size={Math.round(w * 0.15)} color={tone.icon} strokeWidth={1.8} />}
          </Squircle>
        </Animated.View>
        {selecting && (
          <View style={{ position: 'absolute', right: -4, top: h * 0.13 - 8 }}><SelectDot on={!!selected} size={26} onImage /></View>
        )}
      </View>
      <View style={{ alignItems: 'center', gap: 6, maxWidth: w + 16 }}>
        <Text variant="bodyMedium" numberOfLines={1} style={{ fontWeight: '600', letterSpacing: -0.3 }}>{label}</Text>
        {!!count && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 2, borderRadius: 999, backgroundColor: c.panel2 }}>
            {badge}
            <Text variant="footnote" color="ink3" tabular numberOfLines={1}>{count}</Text>
          </View>
        )}
      </View>
    </Pressable>
  )
})

/** One minimal "document": a thumbnail square, a title and a few lines. */
function Skeleton({ accent, line, strong }: { accent: string; line: string; strong: string }) {
  return (
    <View style={{ flex: 1, padding: '13%', gap: '9%' }}>
      <View style={{ flexDirection: 'row', gap: '8%', alignItems: 'flex-start' }}>
        <View style={{ width: '26%', aspectRatio: 1, borderRadius: 4, backgroundColor: accent }} />
        <View style={{ flex: 1, gap: 6, paddingTop: '4%' }}>
          <View style={{ height: 3.5, width: '86%', borderRadius: 2, backgroundColor: strong }} />
          <View style={{ height: 3, width: '58%', borderRadius: 2, backgroundColor: line }} />
        </View>
      </View>
      <View style={{ gap: 5 }}>
        {[100, 90, 74].map((p) => <View key={p} style={{ height: 3, width: `${p}%`, borderRadius: 2, backgroundColor: line }} />)}
      </View>
    </View>
  )
}
