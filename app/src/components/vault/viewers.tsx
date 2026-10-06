// The Vault's file viewer, one native view per kind: photos (pinch, double-tap, swipe between them), video and audio
// players, PDFs drawn page by page by Android itself, Markdown and text, Word as formatted text, spreadsheets as a
// grid with their sheets, slide decks as slides. Anything else: what it is, and Share to open it elsewhere.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { Image } from 'expo-image'
import { useVideoPlayer, VideoView } from 'expo-video'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, ScrollView, View, useWindowDimensions, type ViewToken } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { GoBackward15SecIcon, GoForward15SecIcon, PauseIcon, PlayIcon, Share08Icon } from '@hugeicons/core-free-icons'

import { ImageViewer } from '@/components/chat/image-viewer'
import { api } from '@/lib/api'
import { Phone } from '@/lib/phone'
import { formatSize, kindOf, type Viewable } from '@/lib/vault'
import { type, useTheme } from '@/theme'
import { Button, Icon, Markdown, Segment, Sheet, Skeleton, Squircle, Text, TextField, haptic } from '@/ui'

import { localCopy, shareItem } from './actions'
import { FileTile } from './file-tile'

// Module constants: a list can't take new viewability settings while mounted.
const SWIPE_SEEN = { itemVisiblePercentThreshold: 60 }
const PAGE_SEEN = { viewAreaCoveragePercentThreshold: 50 } // the page covering most of the screen

export function FileBody({ item, siblings, onIndex, chrome, onTap }: {
  item: Viewable
  /** Photos in the same place, for swiping between them. */
  siblings: Viewable[]
  onIndex: (item: Viewable) => void
  /** Header and footer space the body leaves (it may draw under them). */
  chrome: { top: number; bottom: number }
  /** A single tap on a photo (the frame hides or shows its header). */
  onTap?: () => void
}) {
  const kind = kindOf(item.name, item.mime)
  if (kind === 'image') return <Photos items={siblings.length ? siblings : [item]} start={item} onIndex={onIndex} onTap={onTap} />
  if (kind === 'video') return <Video item={item} />
  if (kind === 'audio') return <Audio item={item} />
  if (kind === 'pdf') return <Pdf item={item} chrome={chrome} />
  if (kind === 'markdown' || kind === 'text') return <TextFile item={item} markdown={kind === 'markdown'} chrome={chrome} />
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

// ------------------------------------------------------------------ PDF
/** A PDF, page after page, drawn by Android. It opens where you left off; tap the page count to jump. */
function Pdf({ item, chrome }: { item: Viewable; chrome: { top: number; bottom: number } }) {
  const { width } = useWindowDimensions()
  const [doc, setDoc] = useState<{ uri: string; sizes: [number, number][]; start: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState<string | null>(null)
  const [jump, setJump] = useState(false)
  const list = useRef<FlatList<number>>(null)
  const key = `tl.pdf.page.${item.id}`
  const drawable = !!Phone?.pdfInfo
  useEffect(() => {
    let live = true
    if (!drawable) return
    Promise.all([localCopy(item).then((f) => Phone!.pdfInfo(f.uri).then((info) => ({ uri: f.uri, sizes: info.sizes }))), AsyncStorage.getItem(key).catch(() => null)])
      .then(([d, saved]) => {
        if (!live) return
        const start = Math.min(Math.max(Number(saved) || 1, 1), d.sizes.length)
        setDoc({ ...d, start })
        setPage(start)
      }, (e) => live && setError((e as Error).message))
    return () => { live = false; Phone?.pdfClose() }
  }, [item.id, drawable]) // eslint-disable-line react-hooks/exhaustive-deps
  // Remember the page, a moment after you settle on it.
  useEffect(() => {
    if (!doc) return
    const t = setTimeout(() => AsyncStorage.setItem(key, String(page)).catch(() => {}), 800)
    return () => clearTimeout(t)
  }, [page, doc, key])
  const seen = useCallback((v: { viewableItems: ViewToken<number>[] }) => { if (v.viewableItems[0]) setPage((v.viewableItems[0].index ?? 0) + 1) }, [])
  const w = width - 24
  const layout = useMemo(() => (doc?.sizes ?? []).reduce<{ length: number; offset: number }[]>((out, [pw, ph]) => {
    const prev = out[out.length - 1]
    out.push({ length: (w * ph) / pw + 12, offset: prev ? prev.offset + prev.length : 12 + chrome.top })
    return out
  }, []), [doc, w, chrome.top])
  if (!drawable) return <Other item={item} note="This build can’t draw PDFs yet: update the app." />
  if (error) return <Other item={item} note={error} />
  if (!doc) return <Loading />
  const go = (n: number) => { setJump(false); list.current?.scrollToIndex({ index: Math.min(Math.max(n, 1), doc.sizes.length) - 1, animated: true }) }
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        data={doc.sizes.map((_, i) => i)}
        keyExtractor={(i) => String(i)}
        contentContainerStyle={{ paddingTop: chrome.top + 12, paddingBottom: chrome.bottom + 72, alignItems: 'center' }}
        getItemLayout={(_, i) => ({ ...layout[i], index: i })}
        initialScrollIndex={doc.start - 1}
        onViewableItemsChanged={seen}
        viewabilityConfig={PAGE_SEEN}
        windowSize={5}
        renderItem={({ item: i }) => (
          <View style={{ paddingBottom: 12 }}>
            <PdfPage uri={doc.uri} index={i} width={w} height={(w * doc.sizes[i][1]) / doc.sizes[i][0]} onOpen={setZoom} />
          </View>
        )}
      />
      <Pressable onPress={() => { haptic.tap(); setJump(true) }} accessibilityLabel={`Page ${page} of ${doc.sizes.length}. Go to a page`}
        style={{ position: 'absolute', bottom: chrome.bottom + 20, alignSelf: 'center' }}>
        <Squircle style={{ borderRadius: 16, backgroundColor: 'rgba(24,24,27,0.86)', paddingHorizontal: 14, paddingVertical: 7 }}>
          <Text variant="label" color="#fff" tabular>{page} / {doc.sizes.length}</Text>
        </Squircle>
      </Pressable>
      <PageJump open={jump} pages={doc.sizes.length} page={page} onGo={go} onClose={() => setJump(false)} />
      <ImageViewer url={zoom} name={`${item.name}, page ${page}`} onClose={() => setZoom(null)} />
    </View>
  )
}

function PageJump({ open, pages, page, onGo, onClose }: { open: boolean; pages: number; page: number; onGo: (n: number) => void; onClose: () => void }) {
  const [value, setValue] = useState('')
  const n = Number(value)
  const ok = Number.isInteger(n) && n >= 1 && n <= pages
  return (
    <Sheet open={open} onClose={onClose} title="Go to page">
      <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
        <TextField label={`Page (1–${pages})`} value={value} onChangeText={setValue} keyboardType="number-pad" autoFocus placeholder={String(page)}
          returnKeyType="go" onSubmitEditing={() => ok && onGo(n)} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Button label="First page" variant="soft" fullWidth onPress={() => onGo(1)} /></View>
          <View style={{ flex: 1 }}><Button label="Last page" variant="soft" fullWidth onPress={() => onGo(pages)} /></View>
        </View>
        <Button label="Go" fullWidth size="lg" disabled={!ok} onPress={() => onGo(n)} />
      </View>
    </Sheet>
  )
}

const PdfPage = memo(function PdfPage({ uri, index, width, height, onOpen }: { uri: string; index: number; width: number; height: number; onOpen: (uri: string) => void }) {
  const { scale } = useWindowDimensions()
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    // Drawn at the screen's real pixels (capped), so text is crisp; zooming opens a sharper copy.
    Phone?.pdfPage(uri, index, Math.min(2048, Math.round(width * scale))).then((p) => live && setSrc(p.uri), () => {})
    return () => { live = false }
  }, [uri, index, width, scale])
  return (
    <Pressable onPress={() => src && Phone?.pdfPage(uri, index, 2400).then((p) => onOpen(p.uri), () => onOpen(src))}
      accessibilityLabel={`Page ${index + 1}`} accessibilityHint="Opens the page to zoom in"
      style={{ width, height, borderRadius: 6, overflow: 'hidden', backgroundColor: '#fff', elevation: 2 }}>
      {src ? <Image source={src} style={{ width, height }} contentFit="contain" transition={100} /> : <Skeleton width={width} height={height} radius={6} />}
    </Pressable>
  )
})

// ------------------------------------------------------------------ text and Markdown
function TextFile({ item, markdown, chrome }: { item: Viewable; markdown: boolean; chrome: { top: number; bottom: number } }) {
  const { c } = useTheme()
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tooBig = item.size > 2_000_000
  useEffect(() => {
    if (tooBig) return
    fetch(item.src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Couldn’t open it (${r.status})`))))
      .then(setText, (e) => setError((e as Error).message))
  }, [item.id, tooBig]) // eslint-disable-line react-hooks/exhaustive-deps
  if (tooBig) return <Other item={item} note="It’s too big to show here. Share it to open it in another app." />
  if (error) return <Other item={item} note={error} />
  if (text === null) return <Loading />
  if (markdown) {
    return (
      <ScrollView contentContainerStyle={{ paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 40, paddingHorizontal: 20 }}>
        <Markdown value={text} />
      </ScrollView>
    )
  }
  return (
    <ScrollView contentContainerStyle={{ paddingTop: chrome.top + 12, paddingBottom: chrome.bottom + 40 }}>
      <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: 16 }}>
        <Text selectable style={[type.mono, { color: c.ink }]}>{text}</Text>
      </ScrollView>
    </ScrollView>
  )
}

// ------------------------------------------------------------------ Word, spreadsheets, slides
type PreviewData =
  | { type: 'markdown'; text: string }
  | { type: 'sheets'; sheets: { name: string; rows: string[][]; total: number }[] }
  | { type: 'slides'; slides: Slide[] }
  | { type: 'none' | 'error'; message?: string }

function Preview({ item, chrome }: { item: Viewable; chrome: { top: number; bottom: number } }) {
  const [p, setP] = useState<PreviewData | null>(null)
  useEffect(() => {
    const load = item.preview.startsWith('upload:')
      ? (() => { const form = new FormData(); form.append('file', { uri: item.src, name: item.name, type: item.mime || 'application/octet-stream' } as unknown as Blob); return api<PreviewData>('/preview', { method: 'POST', body: form }) })()
      : api<PreviewData>(item.preview)
    load.then(setP, (e) => setP({ type: 'error', message: (e as Error).message }))
  }, [item.preview, item.src, item.name, item.mime])
  if (!p) return <Loading />
  if (p.type === 'markdown') {
    return (
      <ScrollView contentContainerStyle={{ paddingTop: chrome.top + 16, paddingBottom: chrome.bottom + 40, paddingHorizontal: 20 }}>
        {p.text.trim() ? <Markdown value={p.text} /> : <Text color="ink3">This document is empty.</Text>}
      </ScrollView>
    )
  }
  if (p.type === 'sheets') return <Sheets sheets={p.sheets} chrome={chrome} />
  if (p.type === 'slides') return <Slides slides={p.slides} chrome={chrome} />
  return <Other item={item} note={p.message ?? 'This file can’t be shown here.'} />
}

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + colName(i % 26))

function Sheets({ sheets, chrome }: { sheets: { name: string; rows: string[][]; total: number }[]; chrome: { top: number; bottom: number } }) {
  const { c } = useTheme()
  const [at, setAt] = useState(0)
  const sheet = sheets[at] ?? sheets[0]
  const cols = useMemo(() => {
    const n = Math.max(0, ...sheet.rows.map((r) => r.length))
    return Array.from({ length: n }, (_, j) => Math.min(240, Math.max(64, 22 + 8.2 * Math.max(...sheet.rows.slice(0, 200).map((r) => (r[j] ?? '').length)))))
  }, [sheet])
  const numW = 26 + 8 * String(sheet.rows.length).length
  const cell = (text: string, w: number, head?: boolean, key?: number | string) => (
    <View key={key} style={{ width: w, paddingHorizontal: 8, paddingVertical: 7, borderRightWidth: 1, borderColor: c.line, backgroundColor: head ? c.panel2 : undefined }}>
      <Text variant={head ? 'label' : 'caption'} color={head ? 'ink3' : 'ink'} numberOfLines={head ? 1 : 2} tabular>{text}</Text>
    </View>
  )
  return (
    <View style={{ flex: 1, paddingTop: chrome.top }}>
      {sheets.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12, gap: 8 }} style={{ flexGrow: 0 }}>
          <Segment value={String(at)} onChange={(v) => setAt(Number(v))} accessibilityLabel="Sheet"
            options={sheets.map((s, i) => ({ value: String(i), label: s.name }))} />
        </ScrollView>
      )}
      <ScrollView horizontal bounces={false}>
        <FlatList
          data={sheet.rows}
          keyExtractor={(_, i) => String(i)}
          stickyHeaderIndices={[0]}
          initialNumToRender={40}
          contentContainerStyle={{ paddingBottom: chrome.bottom + 40 }}
          ListHeaderComponent={
            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line, backgroundColor: c.panel2 }}>
              {cell('', numW, true)}
              {cols.map((w, j) => cell(colName(j), w, true, j))}
            </View>
          }
          renderItem={({ item: row, index }) => (
            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line }}>
              {cell(String(index + 1), numW, true)}
              {cols.map((w, j) => cell(row[j] ?? '', w, false, j))}
            </View>
          )}
          ListFooterComponent={sheet.total > sheet.rows.length
            ? <Text variant="footnote" color="ink3" style={{ padding: 12 }}>First {sheet.rows.length} of {sheet.total.toLocaleString()} rows. Share it to see them all.</Text> : null}
        />
      </ScrollView>
    </View>
  )
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

