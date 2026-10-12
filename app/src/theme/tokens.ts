import { Platform } from 'react-native'

// Tubelight design tokens. Neutrals are Tailwind zinc (as in Stepwise UI); `tube` is the one accent.
// `tube` is only for focus, the active item, live/working states and links.

export type ColorScheme = 'light' | 'dark'

const light = {
  canvas: '#fafafa', // zinc-50
  panel: '#ffffff',
  panel2: '#f4f4f5', // zinc-100
  panel3: '#e4e4e7', // zinc-200, pressed wells
  line: 'rgba(0,0,0,0.07)',
  lineStrong: 'rgba(0,0,0,0.12)',
  edge: 'rgba(138,138,141,0.23)', // Stepwise --ui-border, control outlines
  ink: '#18181b', // zinc-900
  ink2: '#52525b', // zinc-600
  ink3: '#71717a', // zinc-500
  ink4: '#a1a1aa', // zinc-400, placeholders
  tube: '#0284c7', // sky-600: sky-500 is under 3:1 as text on white, so light mode steps down one
  tubeSoft: 'rgba(14,165,233,0.12)',
  tubeGlow: 'rgba(56,189,248,0.45)',
  onTube: '#ffffff',
  danger: '#d02f4b',
  dangerSoft: 'rgba(208,47,75,0.08)',
  success: '#1f8a4c',
  successSoft: 'rgba(31,138,76,0.09)',
  warning: '#a86a12',
  warningSoft: 'rgba(168,106,18,0.10)',
  wash: 'rgba(0,0,0,0.05)', // press feedback on transparent surfaces
  washStrong: 'rgba(0,0,0,0.08)',
  scrim: 'rgba(9,9,11,0.32)',
  // Solid (primary) button: zinc-700 → zinc-900 on light
  solidFrom: '#3f3f46',
  solidTo: '#18181b',
  solidInk: '#ffffff',
  solidEdge: 'rgba(0,0,0,0.5)',
  softFrom: '#fafafa',
  softTo: 'rgba(228,228,231,0.7)',
  softEdge: 'rgba(228,228,231,0.9)',
  dangerFrom: '#f43f5e',
  dangerTo: '#e11d48',
  shadow: 'rgba(0,0,0,0.13)',
  imageOutline: 'rgba(0,0,0,0.1)',
}

export type Palette = typeof light

const dark: Palette = {
  canvas: '#09090b', // zinc-950
  panel: '#18181b',
  panel2: '#222226',
  panel3: '#2e2e33',
  line: 'rgba(255,255,255,0.07)',
  lineStrong: 'rgba(255,255,255,0.12)',
  edge: 'rgba(255,255,255,0.10)',
  ink: '#f4f4f5', // zinc-100
  ink2: '#a1a1aa', // zinc-400
  ink3: '#71717a', // zinc-500
  ink4: '#52525b',
  tube: '#0ea5e9', // sky-500
  tubeSoft: 'rgba(14,165,233,0.14)',
  tubeGlow: 'rgba(56,189,248,0.40)',
  onTube: '#ffffff',
  danger: '#f27a8c',
  dangerSoft: 'rgba(242,122,140,0.10)',
  success: '#74d19a',
  successSoft: 'rgba(116,209,154,0.10)',
  warning: '#e8b55a',
  warningSoft: 'rgba(232,181,90,0.10)',
  wash: 'rgba(255,255,255,0.06)',
  washStrong: 'rgba(255,255,255,0.09)',
  scrim: 'rgba(0,0,0,0.55)',
  // Solid button flips to white → zinc-200 on dark
  solidFrom: '#ffffff',
  solidTo: '#e4e4e7',
  solidInk: '#18181b',
  solidEdge: 'rgba(0,0,0,0.12)',
  softFrom: '#27272a',
  softTo: '#18181b',
  softEdge: 'rgba(255,255,255,0.08)',
  dangerFrom: '#e11d48',
  dangerTo: '#be123c',
  shadow: 'rgba(0,0,0,0.5)',
  imageOutline: 'rgba(255,255,255,0.1)',
}

export const palettes = { light, dark }

/** Inter Display, embedded by the expo-font plugin under these family names. */
export const fonts = {
  regular: 'InterDisplay-Regular',
  medium: 'InterDisplay-Medium',
  semibold: 'InterDisplay-SemiBold',
  bold: 'InterDisplay-Bold',
  /** Instrument Serif: documents' serif text (Word's Times, Cambria, Georgia…); regular and italic only. */
  serif: 'InstrumentSerif-Regular',
  serifItalic: 'InstrumentSerif-Italic',
}

/** Type scale 12 / 13 / 15 / 17 / 20 / 28 / 34. Weights 400 / 500 / 600. */
export const type = {
  largeTitle: { fontFamily: fonts.semibold, fontSize: 34, lineHeight: 40, letterSpacing: -0.5 },
  title: { fontFamily: fonts.semibold, fontSize: 28, lineHeight: 33, letterSpacing: -0.4 },
  heading: { fontFamily: fonts.semibold, fontSize: 20, lineHeight: 25, letterSpacing: -0.3 },
  headline: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, letterSpacing: -0.1 },
  bodyMedium: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 22, letterSpacing: -0.15 },
  label: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, letterSpacing: -0.05 },
  caption: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, letterSpacing: 0 },
  footnote: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
  overline: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 16, letterSpacing: 0.2 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', web: 'ui-monospace, Menlo, monospace', default: 'monospace' }), fontSize: 13, lineHeight: 19, letterSpacing: 0 },
} as const

export type TypeVariant = keyof typeof type

export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const

/** Radius scale. Nested radii are concentric: outer = inner + padding. */
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, sheet: 28, pill: 999 } as const

/** Stepwise UI's corner smoothing. */
export const SMOOTHING = 0.6

/** Minimum touch target. */
export const HIT = 44
