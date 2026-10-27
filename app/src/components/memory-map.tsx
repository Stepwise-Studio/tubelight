// Memory → Map: the people, projects and places memory holds, drawn from numbers memory computes (lib/memory-map.ts):
// size = importance, brightness = how recallable right now, fibre = how much more often two come up together than
// chance, distance = how related. Pinch and drag to look around; tap one to see it; "Recall from here" plays the real
// spreading activation. Labels never overlap each other or a node: the most important are placed first, more appear as
// you zoom in. Tapping one brings it and what it's linked to forward and quiets the rest.
import { Canvas, Circle, Path, Skia, useFont } from '@shopify/react-native-skia'
import { router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'

import { api } from '@/lib/api'
import { type GraphData, HUES, LABEL_H, LABEL_PAD, type MemoryMap, STEPS, fillOpacity, layout, placeLabels, separate, spread } from '@/lib/memory-map'
import { demoGraph } from '@/lib/memory-map-demo'
import { useTheme } from '@/theme'
import { Button, EmptyState, Press, Skeleton, Surface, Text, haptic, toast } from '@/ui'

const KIND: Record<string, string> = { person: 'Person', org: 'Organisation', project: 'Project', place: 'Place', period: 'A chapter of your life', thing: 'Thing' }
const PAD = 40
const MAX_ZOOM = 5

const pct = (v: number) => (v >= 0.995 ? '100%' : v >= 0.1 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`)
const ago = (days?: number) => (days === undefined ? 'never' : days < 1 ? 'today' : days < 2 ? 'yesterday' : `${Math.round(days)} days ago`)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function MemoryMapView({ bottom, demo = false }: { bottom: number; demo?: boolean }) {
  const { c, scheme } = useTheme()
  const [data, setData] = useState<GraphData | null | undefined>(() => (demo ? demoGraph() : undefined))
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [picked, setPicked] = useState<number | null>(null)
  const [frames, setFrames] = useState<number[][] | null>(null)
  const [step, setStep] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(() => demo ? undefined : api<GraphData>('/memory/graph').then(setData, (e: Error) => {
    setData((d) => d ?? null)
    toast({ title: 'Unable to load the map', body: e.message, tone: 'error' })
  }), [demo])
  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const map: MemoryMap | null = useMemo(() => (data?.nodes.length ? layout(data) : null), [data])
  const hues = HUES[scheme === 'dark' ? 'dark' : 'light']

  // live gesture as a transform; when it ends the view is committed and everything redraws sharp at the new zoom
  const s = useSharedValue(1), tx = useSharedValue(0), ty = useSharedValue(0), active = useSharedValue(0)
  const commit = useCallback((ds: number, dx: number, dy: number) => {
    setView((v) => {
      const k = clamp(v.k * ds, 1, MAX_ZOOM), r = k / v.k
      const lim = (d: number) => (d * (k - 1)) / 2 + d * 0.25
      return { k, x: clamp(v.x * r + dx, -lim(size.w), lim(size.w)), y: clamp(v.y * r + dy, -lim(size.h), lim(size.h)) }
    })
    s.set(1); tx.set(0); ty.set(0)
  }, [size, s, tx, ty])
  const end = () => {
    'worklet'
    active.set(active.get() - 1)
    if (active.get() === 0) runOnJS(commit)(s.get(), tx.get(), ty.get())
  }
  const gesture = Gesture.Simultaneous(
    Gesture.Pinch().onStart(() => { active.set(active.get() + 1) }).onUpdate((e) => { s.set(e.scale) }).onFinalize(end),
    Gesture.Pan().minDistance(8).onStart(() => { active.set(active.get() + 1) }).onUpdate((e) => { tx.set(e.translationX); ty.set(e.translationY) }).onFinalize(end),
  )
  const live = useAnimatedStyle(() => ({ transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: s.get() }] }))

  // layout → screen at the fitted view, nudged so no two nodes overlap (the layout places centres, not sizes)
  const base = useMemo(() => {
    if (!map || !size.w) return null
    const xs = map.nodes.map((n) => n.x), ys = map.nodes.map((n) => n.y)
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const sc = Math.min((size.w - 2 * PAD) / Math.max(x1 - x0, 1e-6), (size.h - 2 * PAD) / Math.max(y1 - y0, 1e-6), 120)
    return separate(map.nodes.map((n) => ({ x: size.w / 2 + (n.x - (x0 + x1) / 2) * sc, y: size.h / 2 + (n.y - (y0 + y1) / 2) * sc, r: n.r })), size)
  }, [map, size])
  // then the committed zoom and pan: distances grow with zoom, radii with its square root, so zooming makes no overlap
  const pts = useMemo(() => (base ? base.map((p) => ({
    x: size.w / 2 + (p.x - size.w / 2) * view.k + view.x, y: size.h / 2 + (p.y - size.h / 2) * view.k + view.y, r: p.r * Math.sqrt(view.k),
  })) : []), [base, size, view])

  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null }
  const play = (from: number) => {
    if (!map) return
    stop()
    haptic.tap()
    setFrames(spread(map, from))
    setStep(0)
    let k = 0
    timer.current = setInterval(() => { k += 1; setStep(k); if (k >= STEPS) stop() }, 300)
  }
  const reset = () => { stop(); setFrames(null); setStep(0) }

  const fr = frames?.[step]
  // what a tap brings forward: the picked node and everything linked to it
  const near = useMemo(() => {
    if (!map || picked === null) return null
    const out = new Set([picked])
    for (const e of map.edges) if (e.a === picked) out.add(e.b); else if (e.b === picked) out.add(e.a)
    return out
  }, [map, picked])
  // labels: the picked one and its links, or (while recalling) the most reached, or the most important; about ten at
  // the fitted view and more as you zoom in, placed so none overlaps another label or a node
  const texts = useMemo(() => (map ? map.nodes.map((n, i) => n.name + (fr && fr[i] > 0.001 ? ` · ${pct(fr[i])}` : '')) : []), [map, fr])
  // measured with the label's own font; until it loads, the widest Inter Display gets (M: 10.6 px) so nothing overlaps
  const font = useFont(require('@/assets/fonts/InterDisplay-Regular.ttf'), 12)
  const textW = useMemo(() => texts.map((t) => (font ? font.measureText(t).width : t.length * 10.6)), [texts, font])
  const labels = useMemo(() => {
    if (!map || !pts.length) return []
    const score = (i: number) => (fr ? fr[i] : (near?.has(i) ? 100 : 0) + map.nodes[i].mass + 0.2 * map.nodes[i].n)
    const order = map.nodes.map((_, i) => i).filter((i) => !fr || fr[i] > 0.001).sort((a, b) => score(b) - score(a))
    if (picked !== null) order.unshift(picked)
    return placeLabels(pts, textW, [...new Set(order)], size, Math.round(10 * view.k) + (near?.size ?? 0))
  }, [map, pts, textW, fr, near, picked, size, view.k])

  if (data === undefined) return <View style={{ flex: 1, padding: 16 }}><Skeleton height={360} radius={20} /></View>
  if (data === null) return <EmptyState title="The map isn't available" body="Check your connection and open it again." />
  if (!map) {
    return <EmptyState title="Your map is empty so far" body="As people, projects and places come up in your chats, they appear here, linked by how often they come up together." />
  }

  const top = fr ? Math.max(...fr) : 1
  const flow = fr ? map.edges.map((e) => fr[e.a] * e.w + fr[e.b] * e.w) : null
  const flowMax = flow ? Math.max(...flow, 1e-9) : 1
  const wMax = Math.max(...map.edges.map((e) => e.w), 1e-9)
  const sel = picked !== null ? map.nodes[picked] : null
  const from = frames ? frames[0].indexOf(1) : -1
  const ranked = fr ? fr.map((v, i) => [v, i] as const).filter(([v, i]) => i !== from && v > 0.001).sort((a, b) => b[0] - a[0]).slice(0, 4) : []
  const zoomed = view.k > 1.01 || Math.abs(view.x) > 2 || Math.abs(view.y) > 2
  const dim = (i: number) => (fr ? fr[i] <= 0.001 : !!near && !near.has(i))

  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: bottom, gap: 12 }}>
      <Surface style={{ flex: 1, overflow: 'hidden' }}>
        <View style={{ flex: 1 }} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {base && (
            <GestureDetector gesture={gesture}>
              <Animated.View style={[{ flex: 1 }, live]}>
                <Canvas style={{ width: size.w, height: size.h }}>
                  {map.edges.map((e, i) => {
                    const { x: ax, y: ay } = pts[e.a], { x: bx, y: by } = pts[e.b]
                    const on = flow ? flow[i] > 1e-4 : false, f = flow ? flow[i] / flowMax : 0, w = e.w / wMax
                    const mine = picked !== null && (e.a === picked || e.b === picked)
                    // at rest only the stronger links show, faintly; a picked node's links and a recall's flow stand out
                    const o = flow ? (on ? 0.25 + 0.75 * f : 0.05) : near ? (mine ? 0.75 : 0.04) : w < 0.15 ? 0 : 0.1 + 0.3 * w
                    if (!o) return null
                    const p = Skia.Path.Make()
                    p.moveTo(ax, ay)
                    p.quadTo((ax + bx) / 2 + (ay - by) * 0.08, (ay + by) / 2 + (bx - ax) * 0.08, bx, by)
                    return <Path key={i} path={p} style="stroke" strokeCap="round" strokeWidth={0.75 + 1.75 * w + (on ? 2 * f : 0)}
                      color={on || mine ? c.tube : c.ink3} opacity={o} />
                  })}
                  {map.nodes.map((n, i) => {
                    const { x, y, r } = pts[i], v = fr ? fr[i] / top : null
                    const color = dim(i) ? c.ink4 : hues[n.community % hues.length]
                    const fill = (v === null ? fillOpacity(n.recall) : 0.22 + 0.63 * Math.sqrt(v)) * (dim(i) ? 0.5 : 1)
                    const ring = dim(i) ? 0.35 : 0.9
                    // a chapter of your life is a ring only: the people and things in it sit around it
                    return [
                      n.kind === 'period' ? null : <Circle key={`f${i}`} cx={x} cy={y} r={r} color={color} opacity={fill} />,
                      <Circle key={`c${i}`} cx={x} cy={y} r={r} color={color} opacity={ring} style="stroke" strokeWidth={n.kind === 'period' ? 2.5 : 1.25} />,
                    ]
                  })}
                  {/* what memory isn't sure of yet: faint satellites around their entry (agent mem.py tentative facts) */}
                  {map.nodes.flatMap((n, i) => Array.from({ length: Math.min(n.unsure, 6) }, (_, j) => {
                    const { x, y } = pts[i], r = pts[i].r + 6, a = -Math.PI / 2 + (j * 2 * Math.PI) / Math.min(n.unsure, 6)
                    return <Circle key={`u${i}-${j}`} cx={x + r * Math.cos(a)} cy={y + r * Math.sin(a)} r={2} color={c.ink3} opacity={dim(i) ? 0.15 : 0.5} />
                  }))}
                  {picked !== null && <Circle cx={pts[picked].x} cy={pts[picked].y} r={pts[picked].r + 4} color={c.tube} style="stroke" strokeWidth={1.5} />}
                </Canvas>
                {/* touch targets: 44 pt around every node, whether or not it has a label */}
                {map.nodes.map((n, i) => {
                  const { x, y } = pts[i], t = Math.max(22, pts[i].r)
                  return (
                    <Press key={n.id} radius={t} static onPress={() => { haptic.tap(); setPicked(i === picked ? null : i) }}
                      accessibilityLabel={`${n.name}, ${KIND[n.kind] ?? n.kind}, ${n.facts} facts`}
                      outerStyle={{ position: 'absolute', left: x - t, top: y - t, width: 2 * t, height: 2 * t }}>
                      <View style={{ width: 2 * t, height: 2 * t }} />
                    </Press>
                  )
                })}
                {labels.map((l) => (
                  <View key={`l${l.i}`} pointerEvents="none" style={{
                    position: 'absolute', left: l.x, top: l.y, width: l.w, height: LABEL_H, borderRadius: LABEL_H / 2,
                    backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, paddingHorizontal: LABEL_PAD - 1, justifyContent: 'center',
                    opacity: dim(l.i) ? 0.55 : 1,
                  }}>
                    <Text variant="footnote" numberOfLines={1} align="center" color={dim(l.i) ? 'ink3' : 'ink'}>{texts[l.i]}</Text>
                  </View>
                ))}
              </Animated.View>
            </GestureDetector>
          )}
          {zoomed && (
            <View style={{ position: 'absolute', top: 10, right: 10 }}>
              <Button label="Fit" variant="soft" size="sm" onPress={() => { haptic.tap(); setView({ k: 1, x: 0, y: 0 }) }} />
            </View>
          )}
        </View>
      </Surface>

      {frames ? (
        <Surface style={{ padding: 14, gap: 8 }}>
          <Text variant="label" color="ink3">Recalling from {map.nodes[from].name} · step {step} of {STEPS}</Text>
          <Text variant="caption" color="ink2">
            {step === 0 ? `All activation starts on ${map.nodes[from].name}.`
              : step < STEPS ? `Each step, 85% of every memory's activation flows to its neighbours, split by how strongly they're linked; 15% returns to ${map.nodes[from].name}.`
                : `Settled. This is how strongly everything is linked to ${map.nodes[from].name}: what comes to mind first from it.`}
          </Text>
          {ranked.map(([v, i]) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text variant="caption" numberOfLines={1} style={{ flex: 1 }}>{map.nodes[i].name}</Text>
              <View style={{ width: 90, height: 6, borderRadius: 3, backgroundColor: c.panel3, overflow: 'hidden' }}>
                <View style={{ width: `${(100 * v) / ranked[0][0]}%`, height: 6, borderRadius: 3, backgroundColor: hues[map.nodes[i].community % hues.length] }} />
              </View>
              <Text variant="caption" color="ink3" tabular style={{ width: 44, textAlign: 'right' }}>{pct(v)}</Text>
            </View>
          ))}
          {step >= STEPS && !ranked.length && <Text variant="caption" color="ink3">Nothing is linked to it yet.</Text>}
          <Button label="Done" variant="soft" size="sm" onPress={reset} />
        </Surface>
      ) : sel ? (
        <Surface style={{ padding: 14, gap: 10 }}>
          <View style={{ gap: 2 }}>
            <Text variant="bodyMedium">{sel.name}</Text>
            <Text variant="caption" color="ink3">
              {[KIND[sel.kind] ?? sel.kind, `${sel.facts} ${sel.facts === 1 ? 'fact' : 'facts'} of its own`, sel.unsure ? `${sel.unsure} not sure yet` : null,
                `came up in ${sel.n} ${sel.n === 1 ? 'conversation' : 'conversations'}`, `last ${ago(sel.uses[0])}`].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Recall from here" size="sm" onPress={() => play(picked!)} />
            <Button label="Open" variant="soft" size="sm" onPress={() => router.push(`/person/${sel.id}`)} />
          </View>
        </Surface>
      ) : (
        <Surface style={{ padding: 14, gap: 6 }}>
          <Text variant="caption" color="ink2">{"Size is how much its facts matter; brightness, how readily it comes to mind now. A line: two that come up together more than chance. Nearer means more related; colours are groups. Rings are chapters of your life; small dots, what memory isn't sure of yet. You're not a dot: you're in almost everything."}</Text>
          <Text variant="caption" color="ink3" tabular>{`${map.nodes.length} people and things · ${map.edges.length} links · ${map.communities} groups · pinch to zoom, tap one to explore`}</Text>
        </Surface>
      )}
    </View>
  )
}
