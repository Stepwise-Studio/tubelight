// A Word document as the phone draws it (from agent-service docview.py): its real formatting reflowed to the
// screen, the way Google Docs' mobile view shows one. Headings, bold/italic/underline/strike, colours and
// highlights, sizes and fonts (serif and monospace kept), alignment, indents and spacing, numbered and bulleted
// lists, links, images, and tables with their column widths, merged cells and shading. Colours made for white
// paper are adjusted for the dark theme so text stays readable. Long documents draw as they scroll.
import { FlashList } from '@shopify/flash-list'
import { Image } from 'expo-image'
import { memo, useMemo } from 'react'
import { Linking, ScrollView, Text, View, useWindowDimensions, type TextStyle } from 'react-native'

import { fonts, useTheme } from '@/theme'

export interface DocRun { t?: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: string; size?: number; hl?: string; va?: 'sup' | 'sub'; font?: string; link?: string; img?: string | null; w?: number; h?: number }
export interface DocPara { k: 'p'; runs: DocRun[]; align?: 'left' | 'center' | 'right' | 'justify'; indent?: number; first?: number; before?: number; after?: number; line?: number; shade?: string; h?: number; marker?: string; level?: number }
export interface DocCell { blocks: DocBlock[]; span?: number; vmerge?: 'restart' | 'continue'; shade?: string; valign?: 'center' | 'bottom' }
export interface DocTable { k: 'table'; widths: number[]; width: number; rows: { cells: DocCell[]; header?: boolean }[] }
export type DocBlock = DocPara | DocTable
export interface DocData { type: 'doc'; blocks: DocBlock[]; base: number; font?: string }

const SERIF = /times|cambria|georgia|garamond|book antiqua|palatino|constantia|baskerville|minion|serif|century/i
const MONO = /courier|consolas|menlo|monaco|mono|code/i
const PAD = 20 // the page's side margin

interface Ctx {
  k: number // points → px
  dark: boolean
  ink: string
  line: string
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
  const px = Math.min(36, Math.max(10, (r.size ?? base) * x.k * (r.va ? 0.7 : 1)))
  const serif = !!r.font && SERIF.test(r.font)
  const mono = !!r.font && MONO.test(r.font)
  return {
    fontSize: px,
    fontFamily: mono ? 'monospace' : serif ? 'serif' : r.b ? fonts.semibold : fonts.regular,
    fontWeight: (serif || mono) && r.b ? '700' : undefined,
    fontStyle: r.i ? 'italic' : undefined,
    textDecorationLine: r.u && r.s ? 'underline line-through' : r.u ? 'underline' : r.s ? 'line-through' : undefined,
    color: r.hl ? '#18181b' : readable(r.color, x),
    backgroundColor: r.hl ? `#${r.hl}` : undefined,
    ...(r.va ? { lineHeight: px * 1.1, textAlignVertical: r.va === 'sup' ? 'top' : 'bottom' } : null),
  }
}

const Para = memo(function Para({ p, x, base, room }: { p: DocPara; x: Ctx; base: number; room: number }) {
  const texts = p.runs.filter((r) => r.img === undefined)
  const images = p.runs.filter((r) => r.img !== undefined)
  const size = Math.max(...texts.map((r) => r.size ?? base), base) * x.k
  const lineHeight = Math.round(size * 1.25 * Math.max(1, Math.min(p.line ?? 1.15, 2)))
  const indent = Math.min(48, (p.indent ?? 0) * x.k * 0.6)
  const marker = p.marker
  const text = (
    <Text style={{ textAlign: p.align ?? 'left', lineHeight, color: x.ink, flexShrink: 1 }} selectable
      accessibilityRole={p.h !== undefined ? 'header' : undefined}>
      {texts.map((r, i) => (
        <Text key={i} style={runStyle(r, x, base)} onPress={r.link ? () => Linking.openURL(r.link!).catch(() => {}) : undefined}>
          {(r.t ?? '').replace(/\t/g, '    ')}
        </Text>
      ))}
      {!texts.length && !images.length ? ' ' : null}
    </Text>
  )
  return (
    <View style={{ marginTop: Math.min(24, (p.before ?? 0) * x.k * 0.6), marginBottom: Math.min(18, (p.after ?? 0) * x.k * 0.6), paddingLeft: indent,
      backgroundColor: p.shade ? (x.dark ? mix(p.shade, 0, 0.75) : `#${p.shade}`) : undefined }}>
      {marker ? (
        <View style={{ flexDirection: 'row', paddingLeft: (p.level ?? 0) * 14 }}>
          <Text style={{ ...runStyle(texts[0] ?? {}, x, base), minWidth: 22, lineHeight, textDecorationLine: 'none', backgroundColor: undefined }}>{marker}</Text>
          {text}
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
    const words = (b: DocBlock): number => (b.k === 'p' ? Math.max(0, ...b.runs.flatMap((r) => (r.t ?? '').split(/\s+/).map((w) => w.length * (r.size ?? base) * (r.b ? 0.62 : 0.56)))) : 0)
    t.rows.forEach((r) => {
      let at = 0
      r.cells.forEach((cell) => {
        const span = cell.span ?? 1
        if (span === 1) { out[at] = Math.max(out[at], ...cell.blocks.map(words)); chars[at] += cell.blocks.reduce((n, b) => n + text(b), 0) }
        at += span
      })
    })
    return { longest: out.map((v) => Math.min(260, v * x.k + 18)), wordy: chars.map((n) => n / Math.max(1, t.rows.length) > 24) }
  }, [t, cols, base, x.k])
  // Columns of sentences get room to read (~150 px); short ones (numbers, codes) only what they need.
  const widths = shares.map((s, j) => Math.max(wordy[j] ? 150 : 56, longest[j] ?? 0, s * natural))
  // Where each cell sits in the grid, to know which cells merge into the one below.
  const grid = t.rows.map((r) => {
    let at = 0
    return r.cells.map((c) => { const start = at; at += c.span ?? 1; return start })
  })
  const below = (ri: number, col: number) => {
    const next = t.rows[ri + 1]
    if (!next) return false
    const k = grid[ri + 1].indexOf(col)
    return k >= 0 && next.cells[k].vmerge === 'continue'
  }
  const total = widths.reduce((a, b) => a + b, 0)
  const body = (
    <View style={{ width: total, borderTopWidth: 1, borderLeftWidth: 1, borderColor: x.line, marginVertical: 8 }}>
      {t.rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row' }}>
          {row.cells.map((cell, ci) => {
            const col = grid[ri][ci]
            const w = widths.slice(col, col + (cell.span ?? 1)).reduce((a, b) => a + b, 0)
            const head = row.header || (ri === 0 && t.rows.length > 2)
            return (
              <View key={ci} style={{ width: w, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2, borderRightWidth: 1, borderBottomWidth: below(ri, col) ? 0 : 1, borderColor: x.line,
                justifyContent: cell.valign === 'center' ? 'center' : cell.valign === 'bottom' ? 'flex-end' : 'flex-start',
                backgroundColor: cell.shade ? (x.dark ? mix(cell.shade, 0, 0.7) : `#${cell.shade}`) : head && !cell.vmerge ? (x.dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.025)') : undefined }}>
                {cell.vmerge !== 'continue' && cell.blocks.map((b, bi) => <Block key={bi} b={b} x={x} base={base} room={w - 16} tight />)}
              </View>
            )
          })}
        </View>
      ))}
    </View>
  )
  return total > room + 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -PAD }} contentContainerStyle={{ paddingHorizontal: PAD }}>{body}</ScrollView> : body
})

function Block({ b, x, base, room, tight }: { b: DocBlock; x: Ctx; base: number; room: number; tight?: boolean }) {
  if (b.k === 'table') return <Table t={b} x={x} base={base} room={room} />
  // In a cell, paragraph spacing is tightened (Word's 10 pt after every paragraph reads loose in a narrow cell).
  return <Para p={tight ? { ...b, after: Math.min(b.after ?? 0, 4), before: Math.min(b.before ?? 0, 4) } : b} x={x} base={base} room={room} />
}

export function DocView({ doc, chrome }: { doc: DocData; chrome: { top: number; bottom: number } }) {
  const { c, scheme } = useTheme()
  const { width } = useWindowDimensions()
  const base = doc.base || 11
  const x = useMemo<Ctx>(() => ({ k: 15 / Math.max(9, Math.min(base, 14)), dark: scheme === 'dark', ink: c.ink, line: scheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)', width: width - PAD * 2 }),
    [base, scheme, c.ink, width])
  if (!doc.blocks.length) return <Text style={{ color: c.ink3, padding: PAD, paddingTop: chrome.top + 16 }}>This document is empty.</Text>
  return (
    <FlashList data={doc.blocks} keyExtractor={(_, i) => String(i)}
      contentContainerStyle={{ paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 48, paddingHorizontal: PAD }}
      renderItem={({ item }) => <Block b={item} x={x} base={base} room={x.width} />} />
  )
}
