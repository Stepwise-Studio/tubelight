// A file's icon: a page with a folded corner in its type's colour, a white glyph for what it holds, the extension
// below, and (large sizes) a soft glow of its colour underneath. One shape, one colour per kind, so a folder of
// mixed files reads at a glance.
import { memo } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg'

import { kindOf, type FileKind } from '@/lib/vault'
import { fonts } from '@/theme'

export const KIND_COLOR: Record<FileKind, string> = {
  pdf: '#ec3b33', word: '#2b6cf0', sheet: '#1d9f5f', slides: '#f2701d', image: '#0ea5d8', video: '#7c4deb',
  audio: '#e2457d', archive: '#d39516', markdown: '#3f4a5a', text: '#4b5563', other: '#71717a',
}

const LINES = (
  <G fill="#fff">
    <Rect x={11} y={17} width={20} height={3} rx={1.5} />
    <Rect x={11} y={23} width={26} height={3} rx={1.5} opacity={0.85} />
    <Rect x={11} y={29} width={16} height={3} rx={1.5} opacity={0.7} />
  </G>
)

const GLYPH: Record<FileKind, React.ReactNode> = {
  pdf: (
    <G fill="#fff">
      <Rect x={11} y={16} width={26} height={3.2} rx={1.6} />
      <Rect x={11} y={22} width={18} height={3.2} rx={1.6} opacity={0.85} />
      <Rect x={11} y={28} width={22} height={3.2} rx={1.6} opacity={0.7} />
    </G>
  ),
  word: LINES,
  text: LINES,
  markdown: (
    <G fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M11 31V18l5.5 6.5L22 18v13" />
      <Path d="M31 18v13m-4.5-4.5L31 31l4.5-4.5" />
    </G>
  ),
  sheet: (
    <G fill="#fff">
      <Rect x={11} y={15} width={11} height={8} rx={2} />
      <Rect x={25} y={15} width={11} height={8} rx={2} opacity={0.85} />
      <Rect x={11} y={25} width={11} height={8} rx={2} opacity={0.85} />
      <Rect x={25} y={25} width={11} height={8} rx={2} opacity={0.7} />
    </G>
  ),
  slides: (
    <G>
      <Rect x={10} y={15} width={28} height={18} rx={3} fill="none" stroke="#fff" strokeWidth={2.6} />
      <Rect x={15} y={24} width={3.5} height={5} rx={1} fill="#fff" />
      <Rect x={22} y={21} width={3.5} height={8} rx={1} fill="#fff" />
      <Rect x={29} y={19} width={3.5} height={10} rx={1} fill="#fff" />
    </G>
  ),
  image: (
    <G fill="#fff">
      <Circle cx={30.5} cy={19.5} r={3.2} />
      <Path d="M10 33l8.5-10.5 6 7 3.5-4 8 7.5z" />
    </G>
  ),
  video: <Path d="M18 15.5v17.6c0 .9 1 1.4 1.7.9l12.6-8.8c.6-.4.6-1.4 0-1.8L19.7 14.6c-.7-.5-1.7 0-1.7.9z" fill="#fff" />,
  audio: (
    <G fill="#fff">
      <Path d="M21 17.5l12-3v14.5" stroke="#fff" strokeWidth={2.6} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={18} cy={30} r={3.8} />
      <Circle cx={30} cy={28} r={3.8} />
    </G>
  ),
  archive: (
    <G fill="#fff">
      {[13, 19, 25].map((y, i) => <Rect key={y} x={i % 2 ? 24 : 20} y={y} width={4} height={4} rx={1} />)}
      <Rect x={19.5} y={30} width={9} height={6} rx={2} />
    </G>
  ),
  other: LINES,
}

export const FileIcon = memo(function FileIcon({ name, mime = '', size = 44, glow }: { name: string; mime?: string; size?: number; glow?: boolean }) {
  const kind = kindOf(name, mime)
  const color = KIND_COLOR[kind]
  const ext = (name.includes('.') ? name.split('.').pop()! : kind === 'other' ? 'FILE' : kind).slice(0, 4).toUpperCase()
  const w = size * (48 / 56)
  const shadow = glow ?? size >= 60
  const id = `g${kind}`
  return (
    <View style={{ width: w, height: size }} accessibilityLabel={`${ext} file`}>
      <Svg width={w} height={size + (shadow ? size * 0.16 : 0)} viewBox={`0 0 48 ${shadow ? 65 : 56}`} style={{ overflow: 'visible' }}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0.88} />
            <Stop offset="1" stopColor={color} stopOpacity={1} />
          </LinearGradient>
          {shadow && (
            <RadialGradient id={`${id}s`} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={color} stopOpacity={0.45} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </RadialGradient>
          )}
        </Defs>
        {shadow && <Ellipse cx={24} cy={57} rx={20} ry={6} fill={`url(#${id}s)`} />}
        <Path d="M9 0h22.5L48 16.5V47a9 9 0 0 1-9 9H9a9 9 0 0 1-9-9V9a9 9 0 0 1 9-9z" fill={`url(#${id})`} />
        <Path d="M31.5 0v9.5a7 7 0 0 0 7 7H48z" fill="#fff" opacity={0.32} />
        {GLYPH[kind]}
        <SvgText x={24} y={49} fill="#fff" fontSize={ext.length > 3 ? 8.6 : 9.6} fontFamily={fonts.bold} textAnchor="middle" letterSpacing={0.3}>{ext}</SvgText>
      </Svg>
    </View>
  )
})
