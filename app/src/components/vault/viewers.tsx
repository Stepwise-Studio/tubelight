// The Vault's file viewer, one native view per kind: photos (pinch, double-tap, swipe between them), video and audio
// players, PDFs drawn page by page by Android itself, Markdown and text, Word as formatted text, spreadsheets as a
// grid with their sheets, slide decks as slides. Anything else: what it is, and Share to open it elsewhere.
import { FlashList } from '@shopify/flash-list'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { File } from 'expo-file-system'
import { Image } from 'expo-image'
import { useVideoPlayer, VideoView } from 'expo-video'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, Text as RNText, ScrollView, View, useWindowDimensions, type TextStyle, type ViewToken } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { GoBackward15SecIcon, GoForward15SecIcon, PauseIcon, PlayIcon, Share08Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { formatSize, kindOf, type Viewable } from '@/lib/vault'
import { fonts, type, useTheme } from '@/theme'
import { Button, Icon, Markdown, Squircle, Text, haptic } from '@/ui'

import { shareItem } from './actions'
import { FileTile } from './file-tile'
import { DocView, type DocData } from './doc-view'
import { PdfReader } from './pdf-reader'

// Module constants: a list can't take new viewability settings while mounted.
const SWIPE_SEEN = { itemVisiblePercentThreshold: 60 }

export function FileBody({ item, siblings, onIndex, chrome, onTap, onCover }: {
  item: Viewable
  /** Photos in the same place, for swiping between them. */
  siblings: Viewable[]
  onIndex: (item: Viewable) => void
  /** Header and footer space the body leaves (it may draw under them). */
  chrome: { top: number; bottom: number }
  /** A single tap on a photo (the frame hides or shows its header). */
  onTap?: () => void
  /** The body covers the frame's header (PDF search). */
  onCover?: (covered: boolean) => void
}) {
  const kind = kindOf(item.name, item.mime)
  if (kind === 'image') return <Photos items={siblings.length ? siblings : [item]} start={item} onIndex={onIndex} onTap={onTap} />
  if (kind === 'video') return <Video item={item} />
  if (kind === 'audio') return <Audio item={item} />
  if (kind === 'pdf') return <PdfReader item={item} chrome={chrome} onCover={onCover ?? (() => {})} fallback={(note) => <Other item={item} note={note} />} />
  if (kind === 'markdown' || kind === 'text' || kind === 'code') return <TextFile item={item} kind={kind} chrome={chrome} />
  if (kind === 'word' || kind === 'sheet' || kind === 'slides') return <Preview item={item} chrome={chrome} />
  return <Other item={item} />
}

// ------------------------------------------------------------------ photos
function Photos({ items, start, onIndex, onTap }: { items: Viewable[]; start: Viewable; onIndex: (item: Viewable) => void; onTap?: () => void }) {
  const { width, height } = useWindowDimensions()
  const [zoomed, setZoomed] = useState(false)
  const first = Math.max(0, items.findIndex((r) => r.id === start.id))
  const tell = useRef(onIndex)
  useEffect(() => { tell.current = onIndex })
  // FlatList wants the same function for its whole life.
  const seen = useCallback((v: { viewableItems: ViewToken<Viewable>[] }) => { if (v.viewableItems[0]?.item) tell.current(v.viewableItems[0].item) }, [])
  return (
    <FlatList
      data={items}
      horizontal
      pagingEnabled
      scrollEnabled={!zoomed}
      initialScrollIndex={first}
      getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
      showsHorizontalScrollIndicator={false}
      keyExtractor={(r) => r.id}
      onViewableItemsChanged={seen}
      viewabilityConfig={SWIPE_SEEN}
      windowSize={3}
      renderItem={({ item }) => (
        <View style={{ width, height }}>
          <Zoomable uri={item.src} thumb={item.thumb} onZoom={setZoomed} onTap={onTap} label={item.name} />
        </View>
      )}
    />
  )
}

/** Pinch (to 5×), drag while zoomed, double-tap in and out. Not zoomed, swipes go to the list (next photo). */
const Zoomable = memo(function Zoomable({ uri, thumb, onZoom, onTap, label }: { uri: string; thumb?: string; onZoom: (z: boolean) => void; onTap?: () => void; label: string }) {
  const { width, height } = useWindowDimensions()
  const [panning, setPanning] = useState(false)
  const scale = useSharedValue(1)
  const base = useSharedValue(1)
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  const sx = useSharedValue(0)
  const sy = useSharedValue(0)
  const tell = (z: boolean) => { setPanning(z); onZoom(z) }
  const clamp = (v: number, s: number, size: number) => {
    'worklet'
    const max = (size * (s - 1)) / 2
    return Math.min(Math.max(v, -max), max)
  }
  const settle = (s: number, nx: number, ny: number) => {
    'worklet'
    scale.value = withTiming(s)
    base.value = s
    x.value = withTiming(nx)
    y.value = withTiming(ny)
    sx.value = nx
    sy.value = ny
    runOnJS(tell)(s > 1)
  }
  const pinch = Gesture.Pinch()
    .onUpdate((e) => { scale.value = Math.min(Math.max(base.value * e.scale, 1), 5) })
    .onEnd(() => {
      if (scale.value <= 1.01) settle(1, 0, 0)
      else settle(scale.value, clamp(x.value, scale.value, width), clamp(y.value, scale.value, height))
    })
  const pan = Gesture.Pan().enabled(panning).averageTouches(true)
    .onUpdate((e) => {
      x.value = clamp(sx.value + e.translationX, scale.value, width)
      y.value = clamp(sy.value + e.translationY, scale.value, height)
    })
    .onEnd(() => { sx.value = x.value; sy.value = y.value })
  const tap = Gesture.Tap().numberOfTaps(2).onEnd((e) => {
    if (base.value > 1) { settle(1, 0, 0); return }
    const s = 2.5
    settle(s, clamp((width / 2 - e.x) * (s - 1), s, width), clamp((height / 2 - e.y) * (s - 1), s, height))
  })
  const tapOnce = Gesture.Tap().numberOfTaps(1).requireExternalGestureToFail(tap).onEnd(() => { if (onTap) runOnJS(onTap)() })
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }))
  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(tap, tapOnce))}>
      <Animated.View style={[{ flex: 1 }, style]}>
        <Image source={uri} placeholder={thumb} placeholderContentFit="contain" style={{ flex: 1 }} contentFit="contain" transition={120}
          accessibilityLabel={label} accessibilityHint="Pinch or double-tap to zoom" />
      </Animated.View>
    </GestureDetector>
  )
})

// ------------------------------------------------------------------ video and audio
function Video({ item }: { item: Viewable }) {
  const player = useVideoPlayer(item.src, (p) => { p.loop = false; p.play() })
  return (
    <VideoView player={player} nativeControls contentFit="contain" fullscreenOptions={{ enable: true }}
      style={{ flex: 1, backgroundColor: '#000' }} accessibilityLabel={item.name} />
  )
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function Audio({ item }: { item: Viewable }) {
  const { c } = useTheme()
  const player = useAudioPlayer(item.src)
  const status = useAudioPlayerStatus(player)
  const [bar, setBar] = useState(0)
  const dur = status.duration || 0
  const at = status.currentTime || 0
  const seek = (s: number) => { haptic.tap(); player.seekTo(Math.max(0, Math.min(dur, s))) }
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 28 }}>
      <FileTile item={item} size={120} />
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text variant="heading" align="center" numberOfLines={2}>{item.name.replace(/\.[^.]+$/, '')}</Text>
        <Text variant="footnote" color="ink3">{formatSize(item.size)}</Text>
      </View>
      <View style={{ alignSelf: 'stretch', gap: 8 }}>
        <Pressable onLayout={(e) => setBar(e.nativeEvent.layout.width)} onPress={(e) => bar && dur && seek((e.nativeEvent.locationX / bar) * dur)}
          accessibilityRole="adjustable" accessibilityLabel="Position" accessibilityValue={{ text: `${mmss(at)} of ${mmss(dur)}` }}
          style={{ height: 24, justifyContent: 'center' }}>
          <View style={{ height: 4, borderRadius: 2, backgroundColor: c.panel3 }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: c.ink, width: `${dur ? (at / dur) * 100 : 0}%` }} />
          </View>
        </Pressable>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="footnote" color="ink3" tabular>{mmss(at)}</Text>
          <Text variant="footnote" color="ink3" tabular>{dur ? `-${mmss(dur - at)}` : '--:--'}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 28 }}>
        <Pressable onPress={() => seek(at - 15)} accessibilityLabel="Back 15 seconds" hitSlop={12}><Icon icon={GoBackward15SecIcon} size={28} color="ink2" /></Pressable>
        <Pressable onPress={() => { haptic.tap(); if (status.playing) player.pause(); else { if (dur && at >= dur - 0.2) player.seekTo(0); player.play() } }}
          accessibilityLabel={status.playing ? 'Pause' : 'Play'}
          style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: c.ink, alignItems: 'center', justifyContent: 'center' }}>
          {status.isBuffering && !status.playing ? <ActivityIndicator color={c.canvas} />
            : <Icon icon={status.playing ? PauseIcon : PlayIcon} size={30} color={c.canvas} strokeWidth={2} />}
        </Pressable>
        <Pressable onPress={() => seek(at + 15)} accessibilityLabel="Forward 15 seconds" hitSlop={12}><Icon icon={GoForward15SecIcon} size={28} color="ink2" /></Pressable>
      </View>
    </View>
  )
}

// ------------------------------------------------------------------ text and Markdown
function TextFile({ item, kind, chrome }: { item: Viewable; kind: 'markdown' | 'text' | 'code'; chrome: { top: number; bottom: number } }) {
  const markdown = kind === 'markdown'
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tooBig = item.size > 2_000_000
  useEffect(() => {
    if (tooBig) return
    const read = item.src.startsWith('file:') ? new File(item.src).text() // a file on the phone
      : fetch(item.src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Couldn’t open it (${r.status})`))))
    read.then(setText, (e) => setError((e as Error).message))
  }, [item.id, tooBig]) // eslint-disable-line react-hooks/exhaustive-deps
  if (tooBig) return <Other item={item} note="It’s too big to show here. Share it to open it in another app." />
  if (error) return <Other item={item} note={error} />
  if (text === null) return <Loading />
  if (!text.trim()) return <Other item={item} note="This file is empty." />
  if (markdown) return <Doc text={text} chrome={chrome} />
  return <Code text={text} chrome={chrome} prose={kind === 'text'} />
}

const CODE_PX = 13
const CHAR_W = CODE_PX * 0.6 // JetBrains Mono's advance: every character the same width

/** Code and plain text as an editor shows it: JetBrains Mono, line numbers in a quiet gutter, lines kept whole (the
 * page scrolls sideways for long ones), tabs as four spaces, drawn as they scroll in (any length). */
function Code({ text, chrome, prose }: { text: string; chrome: { top: number; bottom: number }; prose?: boolean }) {
  const { c } = useTheme()
  const lines = useMemo(() => text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), [text])
  const gutter = 16 + String(lines.length).length * CHAR_W
  const longest = useMemo(() => lines.reduce((m, l) => Math.max(m, [...l].length), 0), [lines])
  const { width } = useWindowDimensions()
  const inner = Math.max(width, gutter + 16 + longest * CHAR_W + 24)
  const lineStyle = useMemo(() => ({ ...type.mono, fontSize: CODE_PX, lineHeight: 20, color: c.ink }), [c.ink])
  const numStyle = useMemo(() => ({ ...type.mono, fontSize: 11, lineHeight: 20, color: c.ink4, width: gutter, textAlign: 'right' as const }), [c.ink4, gutter])
  if (prose) {
    // A plain text file reads as text: the app's font, lines wrapping to the screen
    return (
      <FlashList data={lines} keyExtractor={(_, i) => String(i)} contentContainerStyle={{ paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 40, paddingHorizontal: 20 }}
        renderItem={({ item }) => <Text selectable>{item || ' '}</Text>} />
    )
  }
  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
      <View style={{ width: inner, height: '100%' }}>
        <FlashList data={lines} keyExtractor={(_, i) => String(i)}
          contentContainerStyle={{ paddingTop: chrome.top + 12, paddingBottom: chrome.bottom + 40 }}
          renderItem={({ item, index }) => (
            <View style={{ flexDirection: 'row', gap: 16, paddingRight: 24 }}>
              <RNText style={numStyle} allowFontScaling={false}>{index + 1}</RNText>
              <RNText style={lineStyle} selectable allowFontScaling={false}>{item || ' '}</RNText>
            </View>
          )} />
      </View>
    </ScrollView>
  )
}

const SUPS: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }
const sup = (label: string) => (/^\d+$/.test(label) ? [...label].map((d) => SUPS[d]).join('') : `[${label}]`)

/** What the Markdown renderer doesn't draw, made readable first: task boxes (☐ ☑), footnotes (raised numbers, their
 * notes kept where they're written), and simple inline HTML (bold, italic, line breaks; other tags dropped). */
function tidyMarkdown(md: string) {
  return md
    .replace(/^(\s*[-*+]\s+)\[([ xX])\]\s+/gm, (_, lead: string, mark: string) => `${lead}${mark === ' ' ? '☐' : '☑'} `)
    .replace(/^\[\^([^\]]+)\]:\s*/gm, (_, label: string) => `${sup(label)} `)
    .replace(/\[\^([^\]]+)\]/g, (_, label: string) => sup(label))
    .replace(/<\/?(b|strong)>/gi, '**')
    .replace(/<\/?(i|em)>/gi, '*')
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<\/?(u|span|div|p|sup|sub|small|font|center)(\s[^>]*)?>/gi, '')
}

const LONG = 12_000 // characters past which a document draws in sections as it scrolls

/** A Markdown document. Short ones draw at once; long ones split at their headings (and big sections between
 * paragraphs) into sections a list draws as they scroll in, so opening and scrolling stay quick. */
function Doc({ text: raw, chrome }: { text: string; chrome: { top: number; bottom: number } }) {
  const text = useMemo(() => tidyMarkdown(raw), [raw])
  const parts = useMemo(() => {
    if (text.length <= LONG) return [text]
    const out: string[] = []
    for (const sec of text.split(/\n(?=#{1,3} )/)) {
      if (sec.length <= 4000) { out.push(sec); continue }
      let cur = ''
      for (const para of sec.split(/\n\n(?![ \t]*[-*+|]|[ \t]*\d+\. )/)) {
        if (cur && cur.length + para.length > 4000) { out.push(cur); cur = '' }
        cur += (cur ? '\n\n' : '') + para
      }
      if (cur) out.push(cur)
    }
    return out
  }, [text])
  const pad = { paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 40, paddingHorizontal: 20 }
  if (parts.length === 1) return <ScrollView contentContainerStyle={pad}><Markdown value={text} /></ScrollView>
  return <FlashList data={parts} keyExtractor={(_, i) => String(i)} contentContainerStyle={pad} renderItem={({ item }) => <View style={{ paddingBottom: 12 }}><Markdown value={item} /></View>} />
}

// ------------------------------------------------------------------ Word, spreadsheets, slides
type PreviewData =
  | { type: 'markdown'; text: string }
  | DocData
  | { type: 'sheets'; sheets: SheetData[] }
  | { type: 'slides'; slides: Slide[] }
  | { type: 'none' | 'error'; message?: string }

/** Previews already fetched this session (a file reopened shows at once; a phone file isn't uploaded again). */
const previews = new Map<string, PreviewData>()

function Preview({ item, chrome }: { item: Viewable; chrome: { top: number; bottom: number } }) {
  const key = `${item.preview}|${item.size}`
  const [p, setP] = useState<PreviewData | null>(previews.get(key) ?? null)
  useEffect(() => {
    if (previews.has(key)) return
    const load = item.preview.startsWith('upload:')
      // Expo's fetch takes a file-system File as a form part (React Native's { uri } objects it refuses)
      ? (() => { const form = new FormData(); form.append('file', new File(item.src) as unknown as Blob, item.name); form.append('name', item.name); return api<PreviewData>('/preview', { method: 'POST', body: form }) })()
      : api<PreviewData>(item.preview)
    load.then((d) => { if (d.type !== 'error' && d.type !== 'none') previews.set(key, d); setP(d) }, (e) => setP({ type: 'error', message: (e as Error).message }))
  }, [key, item.preview, item.src, item.name, item.mime])
  if (!p) return <Loading />
  if (p.type === 'markdown') {
    if (!p.text.trim()) return <Other item={item} note="This document is empty." />
    return <Doc text={p.text} chrome={chrome} />
  }
  if (p.type === 'doc') return <DocView doc={p} chrome={chrome} />
  if (p.type === 'sheets') return <Sheets sheets={p.sheets} chrome={chrome} />
  if (p.type === 'slides') return <Slides slides={p.slides} chrome={chrome} />
  return <Other item={item} note={p.message ?? 'This file can’t be shown here.'} />
}

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + colName(i % 26))

const NUMERIC = /^[-+(]?[₹$€£¥]?(?:[\d,]*\.?\d+)(?:%|e[-+]?\d+)?\)?$/i
const ROW_H = 34 // one line a cell, as a spreadsheet shows them; the bar on top shows a cell's whole value

/** A spreadsheet, the light version of Excel: column letters and row numbers, numbers to the right, the first row
 * bold, a tapped cell outlined with its address and whole value in the bar on top, sheets as tabs along the bottom.
 * Fast with big sheets: fixed row heights, rows memoised (a tap redraws only the rows it touches), one touch target
 * a row (the column comes from where you tapped), cells as plain text. */
/** A cell's look from the file: bold, italic, underline, text colour, fill, alignment, wrap. */
interface CellStyle { b?: 1; i?: 1; u?: 1; c?: string; f?: string; a?: 'left' | 'center' | 'right'; w?: 1 }
interface SheetData { name: string; rows: string[][]; total: number; styles?: Record<string, CellStyle>; merges?: [number, number, number, number][]; widths?: number[]
  /** Per row, '1' for each number or date cell (Excel); CSV has none, so its text is guessed from how it looks. */
  kinds?: string[] }
/** Per row: its cells' styles, merged cells (span: columns a merged cell covers from here; skip: columns drawn by one). */
interface RowExtra { st?: Record<number, CellStyle>; span?: Record<number, number>; skip?: Set<number>; blank?: Set<number>; tall?: boolean }

function rowExtras(sheet: SheetData): RowExtra[] {
  const out: RowExtra[] = sheet.rows.map((r) => (r.some((cell) => cell.includes('\n')) ? { tall: true } : {})) // line breaks in a cell
  for (const [key, st] of Object.entries(sheet.styles ?? {})) {
    const [r, c] = key.split(':').map(Number)
    if (!out[r]) continue
    ;(out[r].st ??= {})[c] = st
    if (st.w) out[r].tall = true
  }
  for (const [r1, c1, r2, c2] of sheet.merges ?? []) {
    for (let r = r1; r <= r2 && r < out.length; r++) {
      ;(out[r].span ??= {})[c1] = c2 - c1 + 1
      for (let c = c1 + 1; c <= c2; c++) (out[r].skip ??= new Set()).add(c)
      if (r > r1) (out[r].blank ??= new Set()).add(c1) // the merged cell's text shows once, in its first row
    }
  }
  return out
}

function Sheets({ sheets, chrome }: { sheets: SheetData[]; chrome: { top: number; bottom: number } }) {
  const { c } = useTheme()
  const [at, setAt] = useState(0)
  const [pick, setPick] = useState<{ r: number; c: number } | null>(null)
  const sheet = sheets[at] ?? sheets[0]
  const cols = useMemo(() => {
    const n = Math.max(0, ...sheet.rows.map((r) => r.length))
    // The file's own column widths when it sets them (Excel's unit ≈ a character), otherwise from the content.
    return Array.from({ length: n }, (_, j) => sheet.widths?.[j] ? Math.round(Math.min(360, Math.max(48, sheet.widths[j] * 7 + 10)))
      : Math.round(Math.min(240, Math.max(64, 22 + 8.2 * Math.max(...sheet.rows.slice(0, 200).map((r) => (r[j] ?? '').length))))))
  }, [sheet])
  const extras = useMemo(() => rowExtras(sheet), [sheet])
  const edges = useMemo(() => cols.reduce<number[]>((out, w) => [...out, (out[out.length - 1] ?? 0) + w], []), [cols]) // right edge of each column
  const numW = 26 + 8 * String(sheet.rows.length).length
  const tap = useCallback((r: number, x: number) => {
    const col = edges.findIndex((e) => x - numW < e)
    if (x < numW || col < 0) return
    haptic.tap()
    setPick((p) => (p?.r === r && p.c === col ? null : { r, c: col }))
  }, [edges, numW])
  const value = pick ? sheet.rows[pick.r]?.[pick.c] ?? '' : ''
  const look = useMemo<SheetLook>(() => ({
    line: c.line, panel2: c.panel2, tube: c.tube, tubeSoft: c.tubeSoft,
    cell: { ...type.caption, color: c.ink, fontVariant: ['tabular-nums'] }, bold: { ...type.caption, color: c.ink, fontWeight: '600', fontVariant: ['tabular-nums'] },
    num: { ...type.footnote, color: c.ink3, fontVariant: ['tabular-nums'] }, numOn: { ...type.footnote, color: c.tube, fontVariant: ['tabular-nums'] },
  }), [c])
  // Only the columns near the screen are drawn (the rest is empty space of the right width), in steps of a few
  // columns so a sideways scroll redraws rows rarely.
  const { width: screen } = useWindowDimensions()
  const [x, setX] = useState(0)
  const span = useMemo(() => {
    const from = Math.max(0, edges.findIndex((e) => e + numW > x - screen * 0.5))
    let to = edges.findIndex((e) => e + numW > x + screen * 1.5)
    if (to < 0) to = cols.length - 1
    const last = Math.max(0, cols.length - 1)
    return { from: Math.min(last, Math.floor(from / 4) * 4), to: Math.min(last, Math.ceil((to + 1) / 4) * 4) }
  }, [edges, numW, x, screen, cols.length])
  return (
    <View style={{ flex: 1, paddingTop: chrome.top }}>
      {/* The cell bar: where you are and what's in it */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, height: 40, borderBottomWidth: 1, borderColor: c.line }}>
        <View style={{ minWidth: 44, height: 26, paddingHorizontal: 8, borderRadius: 8, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="footnote" color="ink2" tabular>{pick ? `${colName(pick.c)}${pick.r + 1}` : '—'}</Text>
        </View>
        <Text variant="caption" color={pick ? 'ink' : 'ink4'} numberOfLines={1} selectable style={{ flex: 1 }}>{pick ? value || 'Empty' : 'Tap a cell to see it here'}</Text>
      </View>
      {!sheet.rows.length ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: chrome.bottom + 72 }}>
          <Text variant="caption" color="ink3">This sheet is empty.</Text>
        </View>
      ) : (
      <ScrollView key={at} horizontal bounces={false} style={{ flex: 1 }} scrollEventThrottle={64}
        onScroll={(e) => { const nx = e.nativeEvent.contentOffset.x; if (Math.abs(nx - x) > screen * 0.25) setX(nx) }}
        onMomentumScrollEnd={(e) => setX(e.nativeEvent.contentOffset.x)}>
        <View style={{ width: numW + (edges[edges.length - 1] ?? 0), height: '100%' }}>
          <HeadRow cols={cols} numW={numW} lit={pick?.c ?? -1} look={look} />
          {/* Rows recycle as they scroll (FlashList): new ones reuse views instead of making them */}
          <FlashList
            data={sheet.rows}
            keyExtractor={(_, i) => String(i)}
            extraData={`${pick?.r}:${pick?.c}:${span.from}:${span.to}`}
            contentContainerStyle={{ paddingBottom: chrome.bottom + 72 }}
            renderItem={({ item: row, index }) => (
              <SheetRow row={row} index={index} cols={cols} edges={edges} numW={numW} from={span.from} to={span.to} lit={pick?.r === index ? pick.c : -1} look={look} onTap={tap} extra={extras[index]} kind={sheet.kinds?.[index]} />
            )}
            ListFooterComponent={sheet.total > sheet.rows.length && sheet.rows.length >= 1000
              ? <Text variant="footnote" color="ink3" style={{ padding: 12 }}>First {sheet.rows.length} of {sheet.total.toLocaleString()} rows. Share it to see them all.</Text> : null}
          />
        </View>
      </ScrollView>
      )}
      {/* Sheets, as tabs along the bottom */}
      {sheets.length > 1 && (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: chrome.bottom + 12, alignItems: 'center' }} pointerEvents="box-none">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, maxWidth: '100%' }} contentContainerStyle={{ paddingHorizontal: 16 }}>
            <View style={{ flexDirection: 'row', gap: 4, padding: 4, borderRadius: 22, backgroundColor: 'rgba(24,24,27,0.92)' }}>
              {sheets.map((sh, i) => (
                <Pressable key={sh.name} onPress={() => { haptic.tap(); setAt(i); setPick(null); setX(0) }} accessibilityRole="tab" accessibilityState={{ selected: i === at }}
                  style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: i === at ? '#fff' : 'transparent' }}>
                  <Text variant="label" color={i === at ? '#18181b' : '#d4d4d8'} numberOfLines={1}>{sh.name}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  )
}

type SheetLook = { line: string; panel2: string; tube: string; tubeSoft: string; cell: TextStyle; bold: TextStyle; num: TextStyle; numOn: TextStyle }

const HeadRow = memo(function HeadRow({ cols, numW, lit, look }: { cols: number[]; numW: number; lit: number; look: SheetLook }) {
  return (
    <View style={{ flexDirection: 'row', height: ROW_H, borderBottomWidth: 1, borderColor: look.line, backgroundColor: look.panel2 }}>
      <View style={{ width: numW, borderRightWidth: 1, borderColor: look.line }} />
      {cols.map((w, j) => (
        <View key={j} style={{ width: w, justifyContent: 'center', alignItems: 'center', borderRightWidth: 1, borderColor: look.line, backgroundColor: j === lit ? look.tubeSoft : undefined }}>
          <Text variant="footnote" color={j === lit ? 'tube' : 'ink3'}>{colName(j)}</Text>
        </View>
      ))}
    </View>
  )
})

/** One row: drawn again only when its cells, its lit cell or the column sizes change. */
const SheetRow = memo(function SheetRow({ row, index, cols, edges, numW, from, to, lit, look, onTap, extra, kind }: {
  row: string[]; index: number; cols: number[]; edges: number[]; numW: number; from: number; to: number; lit: number; look: SheetLook
  onTap: (r: number, x: number) => void; extra?: RowExtra; kind?: string
}) {
  const before = from > 0 ? edges[from - 1] : 0
  const after = edges[edges.length - 1] - (edges[to] ?? 0)
  const height = extra?.tall ? ROW_H * 2 : ROW_H
  const cells = []
  for (let j = from; j <= to; j++) {
    if (extra?.skip?.has(j)) {
      if (j === from) cells.push(<View key={j} pointerEvents="none" style={{ width: cols[j] }} />) // part of a merged cell that starts off screen
      continue
    }
    const span = extra?.span?.[j] ?? 1
    const w = span > 1 ? edges[j + span - 1] - (j ? edges[j - 1] : 0) : cols[j]
    const text = extra?.blank?.has(j) ? '' : row[j] ?? ''
    const st = extra?.st?.[j]
    const fill = st?.f ? `#${st.f}` : undefined
    const ink = st?.c ? `#${st.c}` : fill ? (lightHex(st!.f!) ? '#18181b' : '#fafafa') : undefined
    const align = st?.a ?? (span > 1 ? 'center' : (kind !== undefined ? kind[j] === '1' : text && NUMERIC.test(text)) ? 'right' : 'left')
    cells.push(
      <View key={j} pointerEvents="none" style={[{ width: w, paddingHorizontal: 8, justifyContent: 'center', borderRightWidth: 1, borderColor: look.line, backgroundColor: fill,
        alignItems: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start' },
        j === lit && { borderWidth: 2, borderColor: look.tube, paddingHorizontal: 7 }]}>
        {!!text && (
          <RNText numberOfLines={st?.w || text.includes('\n') ? 3 : 1} maxFontSizeMultiplier={1.3}
            style={[index === 0 || st?.b ? look.bold : look.cell, ink && { color: ink }, st?.i && { fontFamily: index === 0 || st?.b ? fonts.semiboldItalic : fonts.italic }, st?.u && { textDecorationLine: 'underline' }]}>
            {text}
          </RNText>
        )}
      </View>,
    )
  }
  return (
    <Pressable onPress={(e) => onTap(index, e.nativeEvent.locationX)} style={{ flexDirection: 'row', height, borderBottomWidth: 1, borderColor: look.line }}>
      <View pointerEvents="none" style={{ width: numW, justifyContent: 'center', alignItems: 'center', borderRightWidth: 1, borderColor: look.line, backgroundColor: lit >= 0 ? look.tubeSoft : look.panel2 }}>
        <RNText style={lit >= 0 ? look.numOn : look.num} allowFontScaling={false}>{index + 1}</RNText>
      </View>
      {before > 0 && <View pointerEvents="none" style={{ width: before }} />}
      {cells}
      {after > 0 && <View pointerEvents="none" style={{ width: after }} />}
    </Pressable>
  )
})

/** A fill light enough to need dark text. */
function lightHex(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55
}

interface Slide { title: string; subtitle?: string; items: { text: string; level: number }[]; table?: string[][]; notes?: string }

function Slides({ slides, chrome }: { slides: Slide[]; chrome: { top: number; bottom: number } }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const w = width - 32
  return (
    <FlatList
      data={slides}
      keyExtractor={(_, i) => String(i)}
      contentContainerStyle={{ paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 40, paddingHorizontal: 16, gap: 16 }}
      renderItem={({ item: s, index }) => (
        <View style={{ gap: 6 }}>
          <Squircle style={{ width: w, minHeight: w * 9 / 16, borderRadius: 16, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, padding: 20, gap: 10 }}>
            {!!s.title && <Text variant={s.subtitle && !s.items.length ? 'title' : 'heading'}>{s.title}</Text>}
            {!!s.subtitle && <Text variant="headline" color="ink2">{s.subtitle}</Text>}
            {s.items.map((p, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 8, paddingLeft: p.level * 16 }}>
                <Text color="ink3">{p.level ? '◦' : '•'}</Text>
                <Text variant={p.level ? 'caption' : 'body'} color={p.level ? 'ink2' : 'ink'} style={{ flex: 1 }}>{p.text}</Text>
              </View>
            ))}
            {s.table && (
              <View style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, overflow: 'hidden' }}>
                {s.table.slice(0, 12).map((r, i) => (
                  <View key={i} style={{ flexDirection: 'row', backgroundColor: i === 0 ? c.panel2 : undefined, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
                    {r.map((t, j) => <Text key={j} variant={i === 0 ? 'label' : 'caption'} style={{ flex: 1, padding: 6 }} numberOfLines={2}>{t}</Text>)}
                  </View>
                ))}
              </View>
            )}
            {!s.title && !s.subtitle && !s.items.length && !s.table && <Text color="ink3">A picture slide</Text>}
          </Squircle>
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 4 }}>
            <Text variant="footnote" color="ink3" tabular>{index + 1}</Text>
            {s.notes && <Text variant="footnote" color="ink3" style={{ flex: 1 }} numberOfLines={3}>{s.notes}</Text>}
          </View>
        </View>
      )}
    />
  )
}

// ------------------------------------------------------------------ the rest
function Other({ item, note }: { item: Viewable; note?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 18 }}>
      <FileTile item={item} size={96} />
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text variant="headline" align="center" numberOfLines={3}>{item.name}</Text>
        <Text variant="footnote" color="ink3" align="center">{formatSize(item.size)} · {item.mime || 'File'}</Text>
      </View>
      <Text variant="caption" color="ink3" align="center">{note ?? 'This kind of file can’t be shown here. Share it to open it in another app.'}</Text>
      <Button label="Share or open in…" icon={Share08Icon} variant="soft" onPress={() => shareItem(item)} />
    </View>
  )
}

function Loading() {
  const { c } = useTheme()
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.ink3} /></View>
}

