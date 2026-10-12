// The PDF reader: pages drawn by Android itself (PdfRenderer), the way Preview reads.
// - Zoom: pinch (live, around your fingers) or double-tap; on release the pages are laid out again at that size and
//   redrawn sharp, so zoomed text is real resolution, and you scroll the zoomed document both ways.
// - Pages: a floating tray of thumbnails (its button in the corner) to scroll through and jump from; hold the page count and slide to scrub through the pages (page-scrubber).
// - Search: Android 15+ reads the text layer; every match is highlighted on its page, with next/previous.
// It opens where you left off.
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Image } from 'expo-image'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, Keyboard, Pressable, ScrollView, TextInput, View, useWindowDimensions, type ViewToken } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeInDown, FadeInLeft, FadeOutDown, FadeOutLeft, runOnJS, useAnimatedStyle, useSharedValue, withTiming, FadeIn, FadeOut } from 'react-native-reanimated'
import { ArrowDown01Icon, ArrowLeft01Icon, ArrowUp01Icon, Search01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons'

import { Phone } from '@/lib/phone'
import { type Viewable } from '@/lib/vault'
import { motion, useTheme } from '@/theme'
import { Button, Icon, IconButton, Skeleton, Squircle, Text, TextField, elevation, haptic } from '@/ui'

import { localCopy } from './actions'
import { PageScrubber } from './page-scrubber'
import { FileIcon } from './file-icon'

type Match = { page: number; rects: [number, number, number, number][]; text: string }
const GAP = 12
const MAX_ZOOM = 4
const THUMB = 64 // a page's width in the tray
const COLS = 3
const RAIL = COLS * THUMB + (COLS - 1) * 10 + 24 // the page tray's width: three pages a row
const SLIDE_IN = FadeInDown.duration(motion.duration.fast).easing(motion.ease.smoothOut)
const SLIDE_OUT = FadeOutDown.duration(motion.duration.quick)
const QUICK = motion.timing(motion.duration.quick) // plain objects, so worklets can use them
const FAST = motion.timing(motion.duration.fast)
const PAGE_SEEN = { viewAreaCoveragePercentThreshold: 50 } // the page covering most of the screen (a constant: lists can't take new settings)

export function PdfReader({ item, chrome, onCover, fallback }: {
  item: Viewable
  chrome: { top: number; bottom: number }
  /** Search covers the frame's header while it's open. */
  onCover: (covered: boolean) => void
  fallback: (note?: string) => React.ReactNode
}) {
  const { c, scheme } = useTheme()
  const { width, height } = useWindowDimensions()
  const [doc, setDoc] = useState<{ uri: string; sizes: [number, number][]; start: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [rail, setRail] = useState(false)
  const [holding, setHolding] = useState(false) // scrubbing: the controls stay
  const [finding, setFinding] = useState(false)
  // The corner controls step aside while you read (as the system's viewers do) and come back when you scroll.
  const [bare, setBare] = useState(false)
  const [nudge, setNudge] = useState(0) // a scroll ended: wait again before hiding
  useEffect(() => {
    if (bare || holding) return
    const t = setTimeout(() => setBare(true), 2500)
    return () => clearTimeout(t)
  }, [bare, nudge, holding])
  const poke = useCallback(() => { setBare(false); setNudge((n) => n + 1) }, [])
  const [matches, setMatches] = useState<Match[] | null>(null)
  const [hit, setHit] = useState(0)
  const list = useRef<FlatList<number>>(null)
  const across = useRef<ScrollView>(null)
  const offX = useSharedValue(0) // scroll offsets, for keeping a zoom under the fingers
  const offY = useSharedValue(0)
  const [landing, setLanding] = useState<{ x: number; y: number } | null>(null)
  const key = `tl.pdf.page.${item.id}`
  const drawable = !!Phone?.pdfInfo
  const [locked, setLocked] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    if (!drawable) return
    let uri = ''
    Promise.all([localCopy(item).then((f) => { uri = f.uri; return Phone!.pdfInfo(f.uri).then((info) => ({ uri: f.uri, sizes: info.sizes })) }), AsyncStorage.getItem(key).catch(() => null)])
      .then(([d, saved]) => {
        if (!live) return
        const start = Math.min(Math.max(Number(saved) || 1, 1), d.sizes.length)
        setDoc({ ...d, start })
        setPage(start)
      }, (e) => {
        if (!live) return
        if (/password/i.test((e as Error).message) && uri) setLocked(uri) // a locked PDF: ask for its password
        else setError((e as Error).message)
      })
    return () => { live = false; Phone?.pdfClose() }
  }, [item.id, drawable]) // eslint-disable-line react-hooks/exhaustive-deps
  // Remember the page, a moment after you settle on it.
  useEffect(() => {
    if (!doc) return
    const t = setTimeout(() => AsyncStorage.setItem(key, String(page)).catch(() => {}), 800)
    return () => clearTimeout(t)
  }, [page, doc, key])
  const seen = useCallback((v: { viewableItems: ViewToken<number>[] }) => { if (v.viewableItems[0]) setPage((v.viewableItems[0].index ?? 0) + 1) }, [])

  const side = 0 // the page tray floats over the pages; they keep their size
  const base = width - 24 - side // a page's width at zoom 1
  const pw = base * zoom
  // Pages keep their size against the document's usual page (the median width): a receipt-sized page shows small and
  // centred instead of blown up to full width; wider pages (landscape) still fit the screen.
  const usual = useMemo(() => {
    const ws = (doc?.sizes ?? []).map(([w]) => w).sort((a, b) => a - b)
    return ws[Math.floor(ws.length / 2)] || 1
  }, [doc])
  const share = useCallback((w: number) => Math.min(1, w / usual), [usual])
  const layoutAt = useCallback((z: number) => (doc?.sizes ?? []).reduce<{ length: number; offset: number }[]>((out, [w, h]) => {
    const prev = out[out.length - 1]
    out.push({ length: (base * z * share(w) * h) / w + GAP, offset: prev ? prev.offset + prev.length : chrome.top + GAP })
    return out
  }, []), [doc, base, chrome.top, share])
  const layout = useMemo(() => layoutAt(zoom), [layoutAt, zoom])

  // ---- zoom: a live transform while pinching, then the real layout at the new size, kept under the fingers
  const live = useSharedValue(1)
  const fx = useSharedValue(0)
  const fy = useSharedValue(0)
  const zoomed = useSharedValue(1)
  useEffect(() => { zoomed.set(zoom) }, [zoom, zoomed])
  const commit = useCallback((ratio: number, x: number, y: number) => {
    const next = Math.min(Math.max(zoom * ratio, 1), MAX_ZOOM)
    if (Math.abs(next - zoom) < 0.02) { live.set(withTiming(1, QUICK)); return }
    // The document point under the fingers, found on its page, then placed on that page at the new size.
    const docY = offY.get() + y
    const now = layout
    let k = now.findIndex((l) => docY < l.offset + l.length)
    if (k < 0) k = now.length - 1
    const within = now[k] ? (docY - now[k].offset) / now[k].length : 0
    const then = layoutAt(next)
    const newY = then[k] ? then[k].offset + within * then[k].length - y : 0
    const r = next / zoom
    const newX = next === 1 ? 0 : (offX.get() + x - 12 - side) * r - x + 12 + side
    setLanding({ x: Math.max(0, newX), y: Math.max(0, newY) })
    setZoom(next)
  }, [zoom, layout, layoutAt, live, offX, offY, side])
  // After the new layout lands: scroll to keep the spot, then drop the live transform.
  useLayoutEffect(() => {
    if (!landing) return
    list.current?.scrollToOffset({ offset: landing.y, animated: false })
    across.current?.scrollTo({ x: landing.x, animated: false })
    offX.set(landing.x)
    offY.set(landing.y)
    live.set(1)
  }, [landing, live, offX, offY])


  const pinch = Gesture.Pinch()
    .onStart((e) => { fx.set(e.focalX); fy.set(e.focalY) })
    .onUpdate((e) => { live.set(Math.min(Math.max(e.scale, 1 / zoomed.get()), MAX_ZOOM / zoomed.get())) })
    .onEnd(() => { runOnJS(commit)(live.get(), fx.get(), fy.get()) })
  // A tap shows or hides the corner controls (after waiting out a double-tap).
  const flip = useCallback(() => setBare((b) => !b), [])
  const singleTap = Gesture.Tap().numberOfTaps(1).onEnd(() => { runOnJS(flip)() })
  const doubleTap = Gesture.Tap().numberOfTaps(2).maxDelay(250).onEnd((e) => {
    const target = zoomed.get() > 1.05 ? 1 : 2.5
    const ratio = target / zoomed.get()
    fx.set(e.x)
    fy.set(e.y)
    live.set(withTiming(ratio, FAST, (done) => { if (done) runOnJS(commit)(ratio, e.x, e.y) }))
  })
  const area = { w: width, h: height }
  const liveStyle = useAnimatedStyle(() => {
    const s = live.get()
    return { transform: [{ translateX: (fx.get() - area.w / 2) * (1 - s) }, { translateY: (fy.get() - area.h / 2) * (1 - s) }, { scale: s }] }
  })

  // ---- search
  const show = (m: Match) => {
    if (!doc || !layout[m.page]) return
    const f = pw / doc.sizes[m.page][0]
    const [l, t] = m.rects[0] ?? [0, 0]
    list.current?.scrollToOffset({ offset: Math.max(0, layout[m.page].offset + t * f - height * 0.35), animated: true })
    if (zoom > 1) across.current?.scrollTo({ x: Math.max(0, 12 + side + l * f - width * 0.3), animated: true })
  }
  const find = useCallback(async (q: string) => {
    if (!doc || !Phone?.pdfSearch) return
    if (q.trim().length < 2) { setMatches(null); return }
    try {
      const found = await Phone.pdfSearch(doc.uri, q.trim(), 500)
      setMatches(found)
      setHit(0)
      if (found[0]) show(found[0])
    } catch { setMatches([]) }
  }, [doc]) // eslint-disable-line react-hooks/exhaustive-deps
  const step = (d: number) => {
    if (!matches?.length) return
    haptic.tap()
    const n = (hit + d + matches.length) % matches.length
    setHit(n)
    show(matches[n])
  }
  const openFind = () => { haptic.tap(); setRail(false); setFinding(true); onCover(true) }
  const closeFind = () => { Keyboard.dismiss(); setFinding(false); setMatches(null); onCover(false) }

  const byPage = useMemo(() => {
    const m = new Map<number, { rects: Match['rects']; current: boolean }[]>()
    matches?.forEach((x, i) => { const l = m.get(x.page) ?? []; l.push({ rects: x.rects, current: i === hit }); m.set(x.page, l) })
    return m
  }, [matches, hit])

  if (!drawable) return fallback('This build can’t draw PDFs yet: update the app.')
  if (error) return fallback(error)
  if (locked && !doc) return <Locked name={item.name} onUnlock={async (pw) => { const info = await Phone!.pdfUnlock!(locked, pw); setDoc({ uri: locked, sizes: info.sizes, start: 1 }); setPage(1) }} />
  if (!doc) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.ink3} /></View>
  const pages = doc.sizes.length
  const go = (n: number) => {
    const i = Math.min(Math.max(n, 1), pages) - 1
    list.current?.scrollToOffset({ offset: layout[i].offset - chrome.top - GAP + 1, animated: true })
  }

  return (
    <View style={{ flex: 1, overflow: 'hidden' }}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, singleTap))}>
        <Animated.View style={[{ flex: 1 }, liveStyle]}>
          <ScrollView ref={across} horizontal scrollEnabled={zoom > 1} showsHorizontalScrollIndicator={false} bounces={false}
            onScroll={(e) => offX.set(e.nativeEvent.contentOffset.x)} scrollEventThrottle={32}
            contentContainerStyle={{ width: Math.max(width, pw + 24 + side) }}>
            <FlatList
              ref={list}
              style={{ width: Math.max(width, pw + 24 + side) }}
              data={doc.sizes.map((_, i) => i)}
              keyExtractor={(i) => String(i)}
              extraData={byPage}
              contentContainerStyle={{ paddingTop: chrome.top + GAP, paddingBottom: chrome.bottom + 88, paddingLeft: 12 + side, paddingRight: 12 }}
              getItemLayout={(_, i) => ({ ...layout[i], index: i })}
              initialScrollIndex={doc.start - 1}
              onViewableItemsChanged={seen}
              viewabilityConfig={PAGE_SEEN}
              onScroll={(e) => { offY.set(e.nativeEvent.contentOffset.y); if (bare) setBare(false) }}
              onScrollEndDrag={poke}
              onMomentumScrollEnd={poke}
              scrollEventThrottle={32}
              windowSize={zoom > 1.5 ? 3 : 5}
              renderItem={({ item: i }) => {
                const w = pw * share(doc.sizes[i][0])
                return (
                  <View style={{ paddingBottom: GAP, width: pw, alignItems: 'center' }}>
                    <PdfPage uri={doc.uri} index={i} width={w} height={(w * doc.sizes[i][1]) / doc.sizes[i][0]} scale={w / doc.sizes[i][0]} marks={byPage.get(i)} />
                  </View>
                )
              }}
            />
          </ScrollView>
        </Animated.View>
      </GestureDetector>

      {/* Pages: a floating tray of thumbnails, with the tube marking where you are in the document */}
      {rail && (
        <Animated.View entering={FadeInLeft.duration(motion.duration.fast).easing(motion.ease.smoothOut)} exiting={FadeOutLeft.duration(motion.duration.quick)}
          style={[{ position: 'absolute', left: 12, top: chrome.top + 12, bottom: chrome.bottom + 18 + 44 + 12, width: RAIL, borderRadius: 24 }, elevation(scheme)]}>
          <Squircle style={{ flex: 1, borderRadius: 24, overflow: 'hidden', backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
            <Rail uri={doc.uri} sizes={doc.sizes} page={page} onPick={(n) => { haptic.tap(); go(n) }} />
          </Squircle>
        </Animated.View>
      )}

      {/* Pages, on their own in the corner */}
      {!finding && (!bare || rail) && (
        <Animated.View entering={SLIDE_IN} exiting={SLIDE_OUT}
          style={{ position: 'absolute', left: 16, bottom: chrome.bottom + 18 }}>
          <Pressable onPress={() => { haptic.tap(); setRail((r) => !r) }} accessibilityLabel={rail ? 'Hide pages' : 'Show pages'} hitSlop={6}
            style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: rail ? c.tube : 'rgba(24,24,27,0.9)' }}>
            <Icon icon={SidebarLeftIcon} size={19} color={rail ? c.onTube : '#fff'} strokeWidth={1.8} />
          </Pressable>
        </Animated.View>
      )}

      {/* Where you are: hold and slide to scrub through the pages (screen readers step it up and down) */}
      {!finding && (!bare || rail || holding) && (
        <PageScrubber pages={pages} page={page} bottom={chrome.bottom + 18 + 44} onScrub={(n) => go(n)}
          onHold={(h) => { setHolding(h); if (!h) poke() }}>
          {(shown) => (
            <Animated.View entering={SLIDE_IN} exiting={SLIDE_OUT}
              style={{ position: 'absolute', bottom: chrome.bottom + 18, alignSelf: 'center' }}>
              <View accessible accessibilityRole="adjustable" accessibilityLabel="Page" accessibilityValue={{ text: `${page} of ${pages}` }}
                accessibilityHint="Hold and slide to move through the pages"
                accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                onAccessibilityAction={(e) => go(page + (e.nativeEvent.actionName === 'increment' ? 1 : -1))}
                style={{ height: 44, borderRadius: 22, paddingHorizontal: 18, justifyContent: 'center', backgroundColor: holding ? c.tube : 'rgba(24,24,27,0.9)' }}>
                <Text variant="label" color={holding ? c.onTube : '#fff'} tabular>{shown} / {pages}</Text>
              </View>
            </Animated.View>
          )}
        </PageScrubber>
      )}

      {/* Search, on its own in the other corner */}
      {!finding && (!bare || rail) && !!Phone?.pdfSearch && (
        <Animated.View entering={SLIDE_IN} exiting={SLIDE_OUT}
          style={{ position: 'absolute', right: 16, bottom: chrome.bottom + 18 }}>
          <Pressable onPress={openFind} accessibilityLabel="Search in this PDF" hitSlop={6}
            style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(24,24,27,0.9)' }}>
            <Icon icon={Search01Icon} size={19} color="#fff" strokeWidth={1.8} />
          </Pressable>
        </Animated.View>
      )}

      {finding && <FindBar top={chrome.top} matches={matches} hit={hit} onFind={find} onStep={step} onClose={closeFind} />}
    </View>
  )
}

/** Search, over the header: a field, how many, next and previous. */
function FindBar({ top, matches, hit, onFind, onStep, onClose }: {
  top: number; matches: Match[] | null; hit: number
  onFind: (q: string) => void; onStep: (d: number) => void; onClose: () => void
}) {
  const { c } = useTheme()
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => onFind(q), 280)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const n = matches?.length ?? 0
  return (
    <Animated.View entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, height: top, paddingTop: top - 56, backgroundColor: c.canvas, borderBottomWidth: 1, borderColor: c.line }}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, gap: 2 }}>
        <IconButton icon={ArrowLeft01Icon} iconSize={22} accessibilityLabel="Close search" onPress={onClose} />
        <View style={{ flex: 1, height: 40, borderRadius: 20, backgroundColor: c.panel2, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 8 }}>
          <Icon icon={Search01Icon} size={16} color="ink3" />
          <TextInput value={q} onChangeText={setQ} autoFocus placeholder="Find in document" placeholderTextColor={c.ink4} returnKeyType="search"
            onSubmitEditing={() => onStep(1)} selectionColor={c.tube} cursorColor={c.tube} style={{ flex: 1, color: c.ink, fontSize: 15, paddingVertical: 0 }} />
          {matches && <Text variant="footnote" color="ink3" tabular>{n ? `${hit + 1} of ${n}${n >= 500 ? '+' : ''}` : 'None'}</Text>}
        </View>
        <IconButton icon={ArrowUp01Icon} iconSize={20} accessibilityLabel="Previous match" disabled={!n} onPress={() => onStep(-1)} />
        <IconButton icon={ArrowDown01Icon} iconSize={20} accessibilityLabel="Next match" disabled={!n} onPress={() => onStep(1)} />
      </View>
    </Animated.View>
  )
}

/** The page tray, floating over the pages: three pages a row, small and dimmed, the one you're on lit with its
 * number in a tube pill. No scrollbar: the lit page keeps itself in view. */
function Rail({ uri, sizes, page, onPick }: { uri: string; sizes: [number, number][]; page: number; onPick: (n: number) => void }) {
  const { c } = useTheme()
  const ref = useRef<FlatList<number[]>>(null)
  const [box, setBox] = useState(0)
  const cell = Math.round(THUMB * 1.42) // every page sits in an A4-ish box (wider pages centre in it)
  const rowH = cell + 30
  const rows = useMemo(() => Array.from({ length: Math.ceil(sizes.length / COLS) }, (_, r) => sizes.slice(r * COLS, r * COLS + COLS).map((_, k) => r * COLS + k)), [sizes])
  const near = (p: number) => Math.max(0, 12 + Math.floor((p - 1) / COLS) * rowH - box * 0.35)
  const [start] = useState(() => near(page))
  useEffect(() => { if (box) ref.current?.scrollToOffset({ offset: near(page), animated: true }) }, [page, box]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setBox(e.nativeEvent.layout.height)}>
      <FlatList ref={ref} data={rows} keyExtractor={(r) => String(r[0])} contentOffset={{ x: 0, y: start }}
        getItemLayout={(_, i) => ({ length: rowH, offset: 12 + i * rowH, index: i })}
        contentContainerStyle={{ paddingVertical: 12, paddingHorizontal: 12 }} showsVerticalScrollIndicator={false}
        renderItem={({ item: row }) => (
          <View style={{ flexDirection: 'row', gap: 10, height: rowH }}>
            {row.map((i) => {
              const on = i === page - 1
              const [w, h] = sizes[i]
              const fit = Math.min(THUMB / w, cell / h)
              return (
                <Pressable key={i} onPress={() => onPick(i + 1)} accessibilityLabel={`Page ${i + 1}`} accessibilityState={{ selected: on }}
                  style={{ width: THUMB, alignItems: 'center' }}>
                  <View style={{ height: cell, justifyContent: 'center' }}>
                    <View style={{ opacity: on ? 1 : 0.5, borderRadius: 5, borderWidth: 1, borderColor: on ? c.edge : c.line, overflow: 'hidden' }}>
                      <Thumb uri={uri} index={i} width={Math.round(w * fit) - 2} height={Math.round(h * fit) - 2} />
                    </View>
                  </View>
                  <View style={{ marginTop: 5, minWidth: 22, height: 18, paddingHorizontal: 6, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.tubeSoft : undefined }}>
                    <Text variant="footnote" color={on ? 'tube' : 'ink4'} tabular style={{ fontSize: 11, fontWeight: on ? '600' : '400' }}>{i + 1}</Text>
                  </View>
                </Pressable>
              )
            })}
          </View>
        )}
      />
    </View>
  )
}

const Thumb = memo(function Thumb({ uri, index, width, height }: { uri: string; index: number; width: number; height: number }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    Phone?.pdfPage(uri, index, 200).then((p) => live && setSrc(p.uri), () => {})
    return () => { live = false }
  }, [uri, index])
  return (
    <View style={{ width, height, borderRadius: 3, overflow: 'hidden', backgroundColor: '#fff' }}>
      {src && <Image source={src} style={{ width, height }} contentFit="contain" transition={80} />}
    </View>
  )
})

/** One page: drawn at the screen's real pixels for its size (in steps, capped), the last drawing kept while a sharper
 * one comes, and search matches marked on it. */
const PdfPage = memo(function PdfPage({ uri, index, width, height, scale, marks }: {
  uri: string; index: number; width: number; height: number; scale: number
  marks?: { rects: [number, number, number, number][]; current: boolean }[]
}) {
  const { scale: px } = useWindowDimensions()
  const [img, setImg] = useState<{ src: string; prev: string | null } | null>(null)
  const step = Math.min(2400, Math.ceil((width * px) / 480) * 480)
  useEffect(() => {
    let live = true
    Phone?.pdfPage(uri, index, step).then((p) => live && setImg((o) => ({ src: p.uri, prev: o?.src ?? null })), () => {})
    return () => { live = false }
  }, [uri, index, step])
  return (
    <View accessibilityLabel={`Page ${index + 1}`} style={{ width, height, borderRadius: 4, overflow: 'hidden', backgroundColor: '#fff', elevation: 2 }}>
      {img ? <Image source={img.src} placeholder={img.prev} placeholderContentFit="fill" style={{ width, height }} contentFit="fill" transition={img.prev ? 0 : 100} />
        : <Skeleton width={width} height={height} radius={4} />}
      {marks?.map((m, i) => m.rects.map(([l, t, r, b], j) => (
        <View key={`${i}-${j}`} pointerEvents="none" style={{
          position: 'absolute', left: l * scale - 1, top: t * scale - 1, width: (r - l) * scale + 2, height: (b - t) * scale + 2, borderRadius: 2,
          backgroundColor: m.current ? 'rgba(249,115,22,0.45)' : 'rgba(250,204,21,0.38)',
        }} />
      )))}
    </View>
  )
})

/** A password-protected PDF: its password, typed here, opens it (kept only while the app runs). */
function Locked({ name, onUnlock }: { name: string; onUnlock: (password: string) => Promise<void> }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => {
    if (!pw) return
    setBusy(true)
    try { await onUnlock(pw) } catch (e) {
      setErr(/wrong/i.test((e as Error).message) ? 'That password didn’t open it. Try again.' : (e as Error).message)
      setBusy(false)
    }
  }
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
      <View style={{ alignItems: 'center', gap: 8 }}>
        <FileIcon name={name} mime="application/pdf" size={72} />
        <Text variant="headline" align="center">This PDF is locked</Text>
        <Text variant="caption" color="ink3" align="center">Type its password to read it here. It stays on this phone.</Text>
      </View>
      <TextField label="Password" value={pw} onChangeText={(v) => { setPw(v); setErr(null) }} secureTextEntry autoFocus error={err}
        returnKeyType="go" onSubmitEditing={go} autoCapitalize="none" autoCorrect={false} />
      <Button label="Open" size="lg" fullWidth loading={busy} disabled={!pw} onPress={go} />
    </View>
  )
}
