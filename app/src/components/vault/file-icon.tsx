// A file's icon: a page with a folded corner, filled with its type's colour as a soft 400→600 gradient (Stepwise's
// button fills), one quiet white mark for what it holds (no extension label), and (large sizes) a faint shadow of its
// colour underneath. One shape, one colour per kind, so a folder of mixed files reads at a glance.
import { memo } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg'

import { kindOf, type FileKind } from '@/lib/vault'

/** The type's colour (Tailwind 500), for tints elsewhere. */
export const KIND_COLOR: Record<FileKind, string> = {
  pdf: '#f43f5e', word: '#3b82f6', sheet: '#10b981', slides: '#f97316', image: '#0ea5e9', video: '#8b5cf6',
  audio: '#ec4899', archive: '#f59e0b', markdown: '#64748b', text: '#71717a', other: '#71717a',
}
/** The page's fill, top to bottom (Tailwind 400 → 600), like Stepwise's button gradients. */
const FILL: Record<FileKind, [string, string]> = {
  pdf: ['#fb7185', '#e11d48'], word: ['#60a5fa', '#2563eb'], sheet: ['#34d399', '#059669'], slides: ['#fb923c', '#ea580c'],
  image: ['#38bdf8', '#0284c7'], video: ['#a78bfa', '#7c3aed'], audio: ['#f472b6', '#db2777'], archive: ['#fbbf24', '#d97706'],
  markdown: ['#94a3b8', '#475569'], text: ['#a1a1aa', '#52525b'], other: ['#a1a1aa', '#52525b'],
}

// Glyphs: one quiet mark each, white, 2.4 strokes with round ends, in the page's upper half.
const S = { fill: 'none', stroke: '#fff', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const LINES = (
  <G {...S}>
    <Path d="M14 19h20" />
    <Path d="M14 25.5h13" opacity={0.75} />
  </G>
)

const GLYPH: Record<FileKind, React.ReactNode> = {
  pdf: <Path {...S} d="M15.5 30.5c3.5-1.8 6.6-6 7.6-10.3.5-2.3-1.8-2.9-2.3-.6-.9 4.2 4.6 9 10.2 9.7 2.2.3 2.4-1.9.3-2.2-4.6-.6-10.6 1.2-15.8 3.4" />,
  word: <Path {...S} d="M14.5 17.5l3.2 12 6.3-10 6.3 10 3.2-12" />,
  text: LINES,
  other: LINES,
  markdown: (
    <G {...S}>
      <Path d="M13.5 30V19l5 6 5-6v11" />
      <Path d="M31.5 19v10.5m-3.8-3.8l3.8 3.8 3.8-3.8" />
    </G>
  ),
  sheet: (
    <G {...S}>
      <Rect x={13} y={16} width={22} height={16} rx={4} />
      <Path d="M13 23h22M22 16v16" opacity={0.8} />
    </G>
  ),
  slides: (
    <G {...S}>
      <Rect x={12.5} y={16} width={23} height={14} rx={4} />
      <Path d="M24 30v3.5" />
    </G>
  ),
  image: (
    <G {...S}>
      <Path d="M13 31l6.2-6.6c.8-.9 2.1-.9 2.9 0L27 29.5l2.3-2.3c.8-.8 2-.8 2.8 0L35.5 31" />
      <Circle cx={29.5} cy={19.5} r={2.6} />
    </G>
  ),
  video: <Path d="M20 17.8v12.4c0 1.2 1.3 1.9 2.3 1.3l9.6-6.2c.9-.6.9-2 0-2.6l-9.6-6.2c-1-.6-2.3.1-2.3 1.3z" fill="#fff" />,
  audio: (
    <G {...S}>
      <Path d="M15 22.5v3M19.7 19v10.5M24.3 16.5v15M29 20v8M33.5 22.5v3" />
    </G>
  ),
  archive: (
    <G {...S}>
      <Path d="M24 13v3M24 19v3" />
      <Rect x={20.5} y={25} width={7} height={7.5} rx={2.5} />
    </G>
  ),
}

export const FileIcon = memo(function FileIcon({ name, mime = '', size = 44, glow }: { name: string; mime?: string; size?: number; glow?: boolean }) {
  const kind = kindOf(name, mime)
  const ext = (name.includes('.') ? name.split('.').pop()! : kind === 'other' ? 'FILE' : kind).slice(0, 4).toUpperCase()
  const w = size * (48 / 56)
  const shadow = glow ?? size >= 60
  const id = `g${kind}`
  const [top, bottom] = FILL[kind]
  return (
    <View style={{ width: w, height: size }} accessibilityLabel={`${ext} file`}>
      <Svg width={w} height={size + (shadow ? size * 0.16 : 0)} viewBox={`0 0 48 ${shadow ? 65 : 56}`} style={{ overflow: 'visible' }}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={top} />
            <Stop offset="1" stopColor={bottom} />
          </LinearGradient>
          <LinearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#fff" stopOpacity={0.5} />
            <Stop offset="0.35" stopColor="#fff" stopOpacity={0} />
          </LinearGradient>
          {shadow && (
            <RadialGradient id={`${id}s`} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={bottom} stopOpacity={0.32} />
              <Stop offset="1" stopColor={bottom} stopOpacity={0} />
            </RadialGradient>
          )}
        </Defs>
        {shadow && <Ellipse cx={24} cy={57} rx={19} ry={5} fill={`url(#${id}s)`} />}
        <Path d={PAGE} fill={`url(#${id})`} />
        {/* a hairline edge and a soft top light, the way Stepwise buttons sit */}
        <Path d={PAGE} fill="none" stroke={`url(#${id}h)`} strokeWidth={1.2} />
        <Path d={PAGE} fill="none" stroke="#000" strokeOpacity={0.1} strokeWidth={0.6} />
        <Path d="M31.5 0v8.5a8 8 0 0 0 8 8H48z" fill="#fff" opacity={0.3} />
        <G transform="translate(0 6)">{GLYPH[kind]}</G>
      </Svg>
    </View>
  )
})

const PAGE = 'M10 0h21.5L48 16.5V46a10 10 0 0 1-10 10H10A10 10 0 0 1 0 46V10A10 10 0 0 1 10 0z'
