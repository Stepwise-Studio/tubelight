// A Word document as the phone draws it (from agent-service docview.py): its real formatting reflowed to the
// screen, the way Google Docs' mobile view shows one. Headings, bold/italic/underline/strike, colours and
// highlights, sizes and fonts (serif and monospace kept), alignment, indents and spacing, numbered and bulleted
// lists, links, images, tables with their column widths, merged cells and shading, text boxes framed, the header
// and footer at the top and bottom, footnotes as raised numbers with their notes at the end. Colours made for white
// paper are adjusted for the dark theme so text stays readable. Long documents draw as they scroll.
import { FlashList } from '@shopify/flash-list'
import { Image } from 'expo-image'
import { memo, useMemo } from 'react'
import { Linking, ScrollView, Text, View, useWindowDimensions, type TextStyle } from 'react-native'

import { fonts, radius, useTheme } from '@/theme'
import { Squircle } from '@/ui'

export interface DocRun { t?: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: string; size?: number; hl?: string; va?: 'sup' | 'sub'; font?: string; link?: string; img?: string | null; w?: number; h?: number }
export interface DocPara { k: 'p'; runs: DocRun[]; align?: 'left' | 'center' | 'right' | 'justify'; indent?: number; first?: number; before?: number; after?: number; line?: number; shade?: string; h?: number; marker?: string; level?: number }
export interface DocCell { blocks: DocBlock[]; span?: number; vmerge?: 'restart' | 'continue'; shade?: string; valign?: 'center' | 'bottom' }
export interface DocTable { k: 'table'; widths: number[]; width: number; rows: { cells: DocCell[]; header?: boolean }[] }
export interface DocBox { k: 'box'; role: 'header' | 'footer' | 'notes' | 'frame'; blocks: DocBlock[] }
export type DocBlock = DocPara | DocTable | DocBox
export interface DocData { type: 'doc'; blocks: DocBlock[]; base: number; font?: string }

const SERIF = /times|cambria|georgia|garamond|book antiqua|palatino|constantia|baskerville|minion|serif|century/i
const MONO = /courier|consolas|menlo|monaco|mono|code/i
const PAD = 20 // the page's side margin

interface Ctx {
  k: number // points → px
  dark: boolean
  ink: string
  line: string
  wash: string // a table's header row
  width: number // room for text at the top level
}

function lum(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function mix(hex: string, to: number, t: number) {
  return '#' + [0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + to * t).toString(16).padStart(2, '0')).join('')
}

/** A colour made for white paper, readable on this theme's canvas. */
function readable(hex: string | undefined, x: Ctx): string {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return x.ink
  const l = lum(hex)
  if (x.dark) return l < 0.3 ? (l < 0.12 ? x.ink : mix(hex, 255, 0.45)) : mix(hex, 255, 0.15)
  return l > 0.85 ? x.ink : `#${hex}`
}

function runStyle(r: DocRun, x: Ctx, base: number): TextStyle {
  // Superscript and subscript are drawn with the raised/lowered characters (Android can't shift text within a
  // line); runs that have none (letters) are only made smaller.
  const px = Math.min(36, Math.max(10, (r.size ?? base) * x.k * (r.va && !shifted(r) ? 0.7 : 1)))
  const serif = !!r.font && SERIF.test(r.font)
  const mono = !!r.font && MONO.test(r.font)
  return {
    fontSize: px,
    // Serif text in Instrument Serif (its own italic; bold is drawn heavier by Android), sans in Inter Display
    // (Android has no italic or bold of an embedded font unless it's embedded too: asking falls back to Roboto)
    fontFamily: mono ? fonts.mono : serif ? (r.i ? fonts.serifItalic : fonts.serif) : r.b ? (r.i ? fonts.semiboldItalic : fonts.semibold) : r.i ? fonts.italic : fonts.regular,
    fontWeight: undefined,
    // Instrument Serif has no bold (asking Android for one swaps in its sans): a hairline of the same colour thickens it
    ...((serif || mono) && r.b ? { textShadowColor: r.hl ? '#18181b' : readable(r.color, x), textShadowRadius: 0.8, textShadowOffset: { width: 0.4, height: 0 } } : null),
    fontStyle: undefined,
    ...(serif ? { fontSize: px * 1.12 } : null), // Instrument Serif runs small for its size
    textDecorationLine: r.u && r.s ? 'underline line-through' : r.u ? 'underline' : r.s ? 'line-through' : undefined,
    color: r.hl ? '#18181b' : readable(r.color, x),
    backgroundColor: r.hl ? `#${r.hl}` : undefined,

  }
}

const SUP: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' }
const SUB: Record<string, string> = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' }
const shifted = (r: DocRun) => !!r.va && [...(r.t ?? '')].every((ch) => (r.va === 'sup' ? SUP : SUB)[ch])
const shift = (r: DocRun) => (shifted(r) ? [...(r.t ?? '')].map((ch) => (r.va === 'sup' ? SUP : SUB)[ch]).join('') : r.t ?? '')

const Para = memo(function Para({ p, x, base, room }: { p: DocPara; x: Ctx; base: number; room: number }) {
  const texts = p.runs.filter((r) => r.img === undefined)
  const images = p.runs.filter((r) => r.img !== undefined)
  const size = Math.max(...texts.map((r) => r.size ?? base), base) * x.k
  const lineHeight = Math.round(size * 1.25 * Math.max(1, Math.min(p.line ?? 1.15, 2)))
  // Indents as a share of Word's (a phone is a third of a page wide); a list item's marker sits in its hanging indent.
  const indent = Math.min(64, Math.max(0, (p.indent ?? 0) + (p.marker ? Math.min(0, p.first ?? 0) : 0)) * x.k * 0.7)
  const marker = p.marker
  const text = (
    <Text style={{ textAlign: p.align ?? 'left', lineHeight, color: x.ink, flexShrink: 1 }} selectable
      accessibilityRole={p.h !== undefined ? 'header' : undefined}>
      {texts.map((r, i) => (
        <Text key={i} style={runStyle(r, x, base)} onPress={r.link ? () => Linking.openURL(r.link!).catch(() => {}) : undefined}>
          {shift(r).replace(/\t/g, '    ')}
        </Text>
      ))}
      {!texts.length && !images.length ? ' ' : null}
    </Text>
  )
  return (
    <View style={{ marginTop: Math.min(24, (p.before ?? 0) * x.k * 0.6), marginBottom: Math.min(18, (p.after ?? 0) * x.k * 0.6), paddingLeft: indent,
      backgroundColor: p.shade ? (x.dark ? mix(p.shade, 0, 0.75) : `#${p.shade}`) : undefined }}>
      {marker ? (
        <View style={{ flexDirection: 'row' }}>
          <Text style={{ ...runStyle({ ...(texts[0] ?? {}), u: false, s: false, hl: undefined }, x, base), width: Math.max(22, marker.length * size * 0.55 + 8), lineHeight }}>{marker}</Text>
          <View style={{ flex: 1 }}>{text}</View>
        </View>
      ) : texts.length || !images.length ? text : null}
      {images.map((r, i) => {
        const w = Math.min(room - indent, (r.w ?? 300) * x.k * 0.75)
        const h = r.w && r.h ? (w * r.h) / r.w : w * 0.6
        return r.img
          ? <Image key={i} source={r.img} style={{ width: w, height: h, marginVertical: 6, alignSelf: p.align === 'center' ? 'center' : p.align === 'right' ? 'flex-end' : 'flex-start' }} contentFit="contain" />
          : <View key={i} style={{ width: w, height: Math.min(h, 120), marginVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: x.line, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: x.ink, opacity: 0.5, fontSize: 12 }}>Image too large to show here</Text>
            </View>
      })}
    </View>
  )
})

/** A table at its own column widths (scrolling sideways when it's wider than the screen), cells with their own
 * paragraphs, spans and merges drawn as Word draws them. */
const Table = memo(function Table({ t, x, base, room }: { t: DocTable; x: Ctx; base: number; room: number }) {
  const cols = t.widths.length || Math.max(...t.rows.map((r) => r.cells.reduce((n, c) => n + (c.span ?? 1), 0)), 1)
  const shares = t.widths.length ? t.widths : Array(cols).fill(1 / cols)
  // Sized as a share of the page, each column at least wide enough for its longest word (no words broken mid-way);
  // tables that then don't fit scroll sideways, as Google Docs shows them.
  const natural = room * Math.max(0.5, t.width / 468) // a page-wide table (6.5 in of text) fits the screen's width
  const { longest, wordy } = useMemo(() => {
    const out = Array(cols).fill(0)
    const chars = Array(cols).fill(0)
    const text = (b: DocBlock): number => (b.k === 'p' ? b.runs.reduce((n, r) => n + (r.t ?? '').length, 0) : 0)
    t.rows.forEach((r, ri) => {
      const bold = ri === 0 || !!r.header // header rows are drawn semibold
      const words = (b: DocBlock): number => (b.k === 'p' ? Math.max(0, ...b.runs.flatMap((run) => (run.t ?? '').split(/\s+/).map((w) => w.length * (run.size ?? base) * (run.b || bold ? 0.64 : 0.56)))) : 0)
      let at = 0
      r.cells.forEach((cell) => {
        const span = cell.span ?? 1
        if (span === 1) { out[at] = Math.max(out[at], ...cell.blocks.map(words)); chars[at] += cell.blocks.reduce((n, b) => n + text(b), 0) }
        at += span
      })
    })
    return { longest: out.map((v) => Math.min(260, v * x.k + 28)), wordy: chars.map((n) => n / Math.max(1, t.rows.length) > 24) }
  }, [t, cols, base, x.k])
  // Columns of sentences get room to read (~150 px); short ones (numbers, codes) only what they need.
  const widths = shares.map((s, j) => Math.max(wordy[j] ? 150 : 56, longest[j] ?? 0, s * natural))
  // Where each cell sits in the grid, to know which cells merge into the one below.
  const grid = t.rows.map((r) => {
    let at = 0
    return r.cells.map((c) => { const start = at; at += c.span ?? 1; return start })
  })
  const total = widths.reduce((a, b) => a + b, 0)
  // Stepwise's table: a rounded frame, the header row on a wash in semibold, hairlines between rows (a merged
  // cell carries on without one), Word's own cell shading kept.
  const body = (
    <Squircle style={{ width: total, borderRadius: radius.md, borderWidth: 1, borderColor: x.line, overflow: 'hidden', marginVertical: 8 }}>
      {t.rows.map((row, ri) => {
        const head = !!row.header || (ri === 0 && t.rows.length > 1)
        return (
          <View key={ri} style={{ flexDirection: 'row', backgroundColor: head ? x.wash : undefined }}>
            {row.cells.map((cell, ci) => {
              const col = grid[ri][ci]
              const w = widths.slice(col, col + (cell.span ?? 1)).reduce((a, b) => a + b, 0)
              return (
                <View key={ci} style={{ width: w, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 5, borderTopWidth: ri && cell.vmerge !== 'continue' ? 1 : 0, borderColor: x.line,
                  justifyContent: cell.valign === 'center' ? 'center' : cell.valign === 'bottom' ? 'flex-end' : 'flex-start',
                  backgroundColor: cell.shade ? (x.dark ? mix(cell.shade, 0, 0.7) : `#${cell.shade}`) : undefined }}>
                  {cell.vmerge !== 'continue' && cell.blocks.map((b, bi) => <Block key={bi} b={b} x={x} base={base} room={w - 24} tight head={head} />)}
                </View>
              )
            })}
          </View>
        )
      })}
    </Squircle>
  )
  return total > room + 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -PAD }} contentContainerStyle={{ paddingHorizontal: PAD }}>{body}</ScrollView> : body
})

/** The page's header and footer (quiet, above and below a hairline), footnotes under a short rule, a text box in a
 * frame. */
function Box({ b, x, base, room }: { b: DocBox; x: Ctx; base: number; room: number }) {
  const small = b.role === 'frame' ? x : { ...x, k: x.k * 0.85 }
  const inner = b.blocks.map((c, i) => <Block key={i} b={c} x={small} base={base} room={b.role === 'frame' ? room - 26 : room} tight />)
  if (b.role === 'frame') {
    return <Squircle style={{ borderRadius: radius.md, borderWidth: 1, borderColor: x.line, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4, marginVertical: 8 }}>{inner}</Squircle>
  }
  if (b.role === 'notes') return <View style={{ marginTop: 24 }}><View style={{ width: 64, height: 1, backgroundColor: x.line, marginBottom: 10 }} />{inner}</View>
  const head = b.role === 'header'
  return (
    <View style={{ opacity: 0.6, borderColor: x.line, ...(head ? { borderBottomWidth: 1, paddingBottom: 6, marginBottom: 16 } : { borderTopWidth: 1, paddingTop: 10, marginTop: 28 }) }}>
      {inner}
    </View>
  )
}

function Block({ b, x, base, room, tight, head }: { b: DocBlock; x: Ctx; base: number; room: number; tight?: boolean; head?: boolean }) {
  if (b.k === 'table') return <Table t={b} x={x} base={base} room={room} />
  if (b.k === 'box') return <Box b={b} x={x} base={base} room={room} />
  // In a cell, paragraph spacing is tightened (Word's 10 pt after every paragraph reads loose in a narrow cell);
  // header cells are semibold.
  const p = tight ? { ...b, after: Math.min(b.after ?? 0, 4), before: Math.min(b.before ?? 0, 4) } : b
  // Header cells in Stepwise's table: Inter Display semibold, whatever font the document set
  return <Para p={head ? { ...p, runs: p.runs.map((r) => ({ ...r, b: true, font: undefined })) } : p} x={x} base={base} room={room} />
}

export function DocView({ doc, chrome }: { doc: DocData; chrome: { top: number; bottom: number } }) {
  const { c, scheme } = useTheme()
  const { width } = useWindowDimensions()
  const base = doc.base || 11
  const x = useMemo<Ctx>(() => ({ k: 15 / Math.max(9, Math.min(base, 14)), dark: scheme === 'dark', ink: c.ink, line: c.line, wash: c.panel2, width: width - PAD * 2 }),
    [base, scheme, c.ink, c.line, c.panel2, width])
  if (!doc.blocks.length) return <Text style={{ color: c.ink3, padding: PAD, paddingTop: chrome.top + 16 }}>This document is empty.</Text>
  return (
    <FlashList data={doc.blocks} keyExtractor={(_, i) => String(i)}
      contentContainerStyle={{ paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 48, paddingHorizontal: PAD }}
      renderItem={({ item }) => <Block b={item} x={x} base={base} room={x.width} />} />
  )
}
