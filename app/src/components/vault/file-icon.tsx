// A file's icon: a page with a folded corner, filled with its type's colour as a soft 400→600 gradient (Stepwise's
// button fills), one quiet white mark for what it holds (no extension label), and (large sizes) a faint shadow of its
// colour underneath. One shape, one colour per kind, so a folder of mixed files reads at a glance.
import { memo } from 'react'
import { View } from 'react-native'
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg'

import { kindOf, type FileKind } from '@/lib/vault'

/** The type's colour (Tailwind 500), for tints elsewhere. */
export const KIND_COLOR: Record<FileKind, string> = {
  pdf: '#f43f5e', word: '#3b82f6', sheet: '#10b981', slides: '#f97316', image: '#0ea5e9', video: '#8b5cf6',
  audio: '#ec4899', archive: '#f59e0b', markdown: '#64748b', text: '#71717a', code: '#52525b', other: '#71717a',
}
/** The page's fill, top to bottom (Tailwind 400 → 600), like Stepwise's button gradients. */
const FILL: Record<FileKind, [string, string]> = {
  pdf: ['#fb7185', '#e11d48'], word: ['#60a5fa', '#2563eb'], sheet: ['#34d399', '#059669'], slides: ['#fb923c', '#ea580c'],
  image: ['#38bdf8', '#0284c7'], video: ['#a78bfa', '#7c3aed'], audio: ['#f472b6', '#db2777'], archive: ['#fbbf24', '#d97706'],
  markdown: ['#94a3b8', '#475569'], text: ['#a1a1aa', '#52525b'], code: ['#71717a', '#3f3f46'], other: ['#a1a1aa', '#52525b'],
}

// Glyphs: one white mark each, drawn in the page's own coordinates (48×56), 2.6 strokes with round ends: PDF a
// three-loop rose (Acrobat's idea, symmetric), Word and text lines, archives a zipper and its pull, Markdown the M↓
// mark, photos a hill and sun, sheets a grid, slides a screen on two legs, video play, audio a waveform, code braces.
const S = { fill: 'none', stroke: '#fff', strokeWidth: 2.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const GLYPH: Record<FileKind, React.ReactNode> = {
  pdf: <G><Path {...S} d="M24.0 20.0 L24.1 20.0 L24.2 20.0 L24.3 20.0 L24.4 20.1 L24.5 20.1 L24.6 20.2 L24.8 20.2 L24.9 20.3 L25.0 20.4 L25.1 20.5 L25.1 20.6 L25.2 20.7 L25.3 20.8 L25.4 20.9 L25.5 21.1 L25.6 21.2 L25.7 21.3 L25.7 21.5 L25.8 21.7 L25.9 21.8 L25.9 22.0 L26.0 22.2 L26.1 22.4 L26.1 22.6 L26.1 22.8 L26.2 23.0 L26.2 23.3 L26.2 23.5 L26.3 23.7 L26.3 24.0 L26.3 24.2 L26.3 24.5 L26.3 24.7 L26.3 25.0 L26.3 25.2 L26.3 25.5 L26.2 25.8 L26.2 26.1 L26.2 26.3 L26.1 26.6 L26.1 26.9 L26.0 27.2 L26.0 27.5 L25.9 27.8 L25.8 28.1 L25.8 28.4 L25.7 28.7 L25.6 29.0 L25.5 29.3 L25.4 29.6 L25.3 29.9 L25.1 30.2 L25.0 30.5 L24.9 30.8 L24.8 31.1 L24.6 31.3 L24.5 31.6 L24.3 31.9 L24.2 32.2 L24.0 32.5 L23.8 32.8 L23.7 33.1 L23.5 33.3 L23.3 33.6 L23.1 33.9 L22.9 34.1 L22.7 34.4 L22.5 34.7 L22.3 34.9 L22.1 35.2 L21.9 35.4 L21.7 35.6 L21.5 35.9 L21.3 36.1 L21.1 36.3 L20.9 36.5 L20.7 36.7 L20.4 36.9 L20.2 37.1 L20.0 37.3 L19.8 37.5 L19.5 37.6 L19.3 37.8 L19.1 38.0 L18.9 38.1 L18.6 38.3 L18.4 38.4 L18.2 38.5 L18.0 38.6 L17.8 38.8 L17.5 38.9 L17.3 39.0 L17.1 39.0 L16.9 39.1 L16.7 39.2 L16.5 39.3 L16.3 39.3 L16.1 39.4 L15.9 39.4 L15.7 39.5 L15.5 39.5 L15.3 39.5 L15.2 39.5 L15.0 39.5 L14.8 39.5 L14.7 39.5 L14.5 39.5 L14.4 39.5 L14.2 39.5 L14.1 39.4 L14.0 39.4 L13.9 39.3 L13.8 39.3 L13.6 39.2 L13.5 39.2 L13.5 39.1 L13.4 39.0 L13.3 38.9 L13.2 38.8 L13.2 38.8 L13.1 38.7 L13.1 38.6 L13.0 38.4 L13.0 38.3 L13.0 38.2 L13.0 38.1 L13.0 38.0 L13.0 37.9 L13.0 37.7 L13.1 37.6 L13.1 37.5 L13.1 37.3 L13.2 37.2 L13.3 37.1 L13.3 36.9 L13.4 36.8 L13.5 36.6 L13.6 36.5 L13.7 36.3 L13.8 36.2 L14.0 36.1 L14.1 35.9 L14.2 35.8 L14.4 35.6 L14.5 35.5 L14.7 35.3 L14.9 35.2 L15.1 35.1 L15.3 34.9 L15.5 34.8 L15.7 34.7 L15.9 34.5 L16.1 34.4 L16.3 34.3 L16.6 34.1 L16.8 34.0 L17.1 33.9 L17.3 33.8 L17.6 33.7 L17.8 33.6 L18.1 33.5 L18.4 33.4 L18.7 33.3 L19.0 33.2 L19.3 33.1 L19.6 33.0 L19.9 33.0 L20.2 32.9 L20.5 32.8 L20.8 32.8 L21.1 32.7 L21.4 32.7 L21.7 32.6 L22.0 32.6 L22.4 32.6 L22.7 32.5 L23.0 32.5 L23.3 32.5 L23.7 32.5 L24.0 32.5 L24.3 32.5 L24.7 32.5 L25.0 32.5 L25.3 32.5 L25.6 32.6 L26.0 32.6 L26.3 32.6 L26.6 32.7 L26.9 32.7 L27.2 32.8 L27.5 32.8 L27.8 32.9 L28.1 33.0 L28.4 33.0 L28.7 33.1 L29.0 33.2 L29.3 33.3 L29.6 33.4 L29.9 33.5 L30.2 33.6 L30.4 33.7 L30.7 33.8 L30.9 33.9 L31.2 34.0 L31.4 34.1 L31.7 34.3 L31.9 34.4 L32.1 34.5 L32.3 34.7 L32.5 34.8 L32.7 34.9 L32.9 35.1 L33.1 35.2 L33.3 35.3 L33.5 35.5 L33.6 35.6 L33.8 35.8 L33.9 35.9 L34.0 36.1 L34.2 36.2 L34.3 36.3 L34.4 36.5 L34.5 36.6 L34.6 36.8 L34.7 36.9 L34.7 37.1 L34.8 37.2 L34.9 37.3 L34.9 37.5 L34.9 37.6 L35.0 37.7 L35.0 37.9 L35.0 38.0 L35.0 38.1 L35.0 38.2 L35.0 38.3 L35.0 38.4 L34.9 38.6 L34.9 38.7 L34.8 38.8 L34.8 38.8 L34.7 38.9 L34.6 39.0 L34.5 39.1 L34.5 39.2 L34.4 39.2 L34.2 39.3 L34.1 39.3 L34.0 39.4 L33.9 39.4 L33.8 39.5 L33.6 39.5 L33.5 39.5 L33.3 39.5 L33.2 39.5 L33.0 39.5 L32.8 39.5 L32.7 39.5 L32.5 39.5 L32.3 39.5 L32.1 39.4 L31.9 39.4 L31.7 39.3 L31.5 39.3 L31.3 39.2 L31.1 39.1 L30.9 39.0 L30.7 39.0 L30.5 38.9 L30.2 38.8 L30.0 38.6 L29.8 38.5 L29.6 38.4 L29.4 38.3 L29.1 38.1 L28.9 38.0 L28.7 37.8 L28.5 37.6 L28.2 37.5 L28.0 37.3 L27.8 37.1 L27.6 36.9 L27.3 36.7 L27.1 36.5 L26.9 36.3 L26.7 36.1 L26.5 35.9 L26.3 35.6 L26.1 35.4 L25.9 35.2 L25.7 34.9 L25.5 34.7 L25.3 34.4 L25.1 34.1 L24.9 33.9 L24.7 33.6 L24.5 33.3 L24.3 33.1 L24.2 32.8 L24.0 32.5 L23.8 32.2 L23.7 31.9 L23.5 31.6 L23.4 31.3 L23.2 31.1 L23.1 30.8 L23.0 30.5 L22.9 30.2 L22.7 29.9 L22.6 29.6 L22.5 29.3 L22.4 29.0 L22.3 28.7 L22.2 28.4 L22.2 28.1 L22.1 27.8 L22.0 27.5 L22.0 27.2 L21.9 26.9 L21.9 26.6 L21.8 26.3 L21.8 26.1 L21.8 25.8 L21.7 25.5 L21.7 25.2 L21.7 25.0 L21.7 24.7 L21.7 24.5 L21.7 24.2 L21.7 24.0 L21.7 23.7 L21.8 23.5 L21.8 23.3 L21.8 23.0 L21.9 22.8 L21.9 22.6 L21.9 22.4 L22.0 22.2 L22.1 22.0 L22.1 21.8 L22.2 21.7 L22.3 21.5 L22.3 21.3 L22.4 21.2 L22.5 21.1 L22.6 20.9 L22.7 20.8 L22.8 20.7 L22.9 20.6 L22.9 20.5 L23.0 20.4 L23.1 20.3 L23.2 20.2 L23.4 20.2 L23.5 20.1 L23.6 20.1 L23.7 20.0 L23.8 20.0 L23.9 20.0Z"/></G>,
  word: <G><Path {...S} d="M14 26h20M14 32.5h20M14 39h12"/></G>,
  archive: <G><G fill="#fff"><Rect x={19} y={3.0} width={5} height={3.4} rx={1.2}/><Rect x={24} y={6.4} width={5} height={3.4} rx={1.2}/><Rect x={19} y={9.8} width={5} height={3.4} rx={1.2}/><Rect x={24} y={13.2} width={5} height={3.4} rx={1.2}/><Rect x={19} y={16.6} width={5} height={3.4} rx={1.2}/><Rect x={24} y={20.0} width={5} height={3.4} rx={1.2}/></G><Path fill="#fff" fillRule="evenodd" d="M21.5 25h5a3.5 3.5 0 0 1 3.5 3.5v8a3.5 3.5 0 0 1-3.5 3.5h-5a3.5 3.5 0 0 1-3.5-3.5v-8a3.5 3.5 0 0 1 3.5-3.5zM24 32a1.3 1.3 0 0 0-1.3 1.3v2.2a1.3 1.3 0 0 0 2.6 0v-2.2A1.3 1.3 0 0 0 24 32z"/></G>,
  markdown: <G><Rect x={9.5} y={24} width={29} height={17} rx={4} {...S}/><Path {...S} d="M14.5 36.5v-8l3.75 4.5 3.75-4.5v8M30.5 28.5v8m-3.2-3.2l3.2 3.2 3.2-3.2"/></G>,
  image: <G><Path fill="#fff" d="M10 42.5h28c1 0 1.5-1.2.9-1.9l-4.5-5a2.4 2.4 0 0 0-3.5 0l-3.1 3.3-6-6.7a2.4 2.4 0 0 0-3.6 0L9.1 40.6c-.6.7-.1 1.9.9 1.9z"/><Circle cx={31} cy={26} r={3.2} fill="#fff"/></G>,
  sheet: <G><Rect x={12} y={23} width={24} height={18} rx={4} {...S}/><Path {...S} d="M12 30h24M21 23v18" opacity={0.85}/></G>,
  slides: <G><Rect x={11} y={23} width={26} height={15} rx={3.5} {...S}/><Path {...S} d="M19 38l-2.5 5M29 38l2.5 5"/></G>,
  video: <G><Path fill="#fff" d="M20.5 26.3v13.4c0 1.4 1.5 2.2 2.7 1.5l10.2-6.7c1-.7 1-2.3 0-3l-10.2-6.7c-1.2-.7-2.7.1-2.7 1.5z"/></G>,
  audio: <G><Path {...S} d="M14.5 30.5v4M19.25 27v11M24 24v17M28.75 28v9M33.5 30.5v4"/></G>,
  text: <G><Path {...S} d="M14 26h20M14 32.5h20M14 39h12"/></G>,
  code: <G><Path {...S} d="M19.5 24.5c-2.6 0-3.5 1.2-3.5 3.2v1.6c0 1.6-.8 2.7-2.7 2.7 1.9 0 2.7 1.1 2.7 2.7v1.6c0 2 .9 3.2 3.5 3.2M28.5 24.5c2.6 0 3.5 1.2 3.5 3.2v1.6c0 1.6.8 2.7 2.7 2.7-1.9 0-2.7 1.1-2.7 2.7v1.6c0 2-.9 3.2-3.5 3.2"/></G>,
  other: <G><Path {...S} d="M14 26h20M14 32.5h20M14 39h12" /></G>,
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
            <Stop offset="0" stopColor="#fff" stopOpacity={0.55} />
            <Stop offset="0.35" stopColor="#fff" stopOpacity={0} />
          </LinearGradient>
          {shadow && (
            <RadialGradient id={`${id}s`} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={bottom} stopOpacity={0.32} />
              <Stop offset="1" stopColor={bottom} stopOpacity={0} />
            </RadialGradient>
          )}
          <ClipPath id={`${id}c`}><Path d={PAGE} /></ClipPath>
        </Defs>
        {shadow && <Ellipse cx={24} cy={57} rx={19} ry={5} fill={`url(#${id}s)`} />}
        <Path d={PAGE} fill={`url(#${id})`} />
        {/* a hairline edge, a soft top light and the folded corner, all kept inside the page (strokes drawn on its
            outline get cut flat by the icon's own edges) */}
        <G clipPath={`url(#${id}c)`}>
          <Path d={PAGE} fill="none" stroke={`url(#${id}h)`} strokeWidth={2.4} />
          <Path d={PAGE} fill="none" stroke="#000" strokeOpacity={0.12} strokeWidth={1.2} />
          <Path d="M31 -2V8.5a8 8 0 0 0 8 8H50V-2z" fill="#fff" opacity={0.3} />
        </G>
        <G clipPath={`url(#${id}c)`}>{GLYPH[kind]}</G>
      </Svg>
    </View>
  )
})

// The page: rounded corners, and the fold's two joins rounded too (no hard points where it meets the top and side).
const PAGE = 'M10 0H29.4Q31.5 0 33 1.5L46.5 15Q48 16.5 48 18.6V46A10 10 0 0 1 38 56H10A10 10 0 0 1 0 46V10A10 10 0 0 1 10 0Z'
