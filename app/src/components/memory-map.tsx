// Memory → Map: the people, projects and places memory holds, drawn from numbers memory computes (lib/memory-map.ts):
// size = importance, brightness = how recallable right now, fibre = how much more often two come up together than
// chance, distance = how related. Pinch and drag to look around; tap one to see it; "Recall from here" plays the real
// spreading activation. Labels never overlap: the most important are placed first, the rest appear as you zoom in.
import { BlurMask, Canvas, Circle, Path, Skia } from '@shopify/react-native-skia'
import { router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated'

import { api } from '@/lib/api'
import { type GraphData, type MemoryMap, STEPS, layout, spread } from '@/lib/memory-map'
import { useTheme } from '@/theme'
import { Button, EmptyState, Press, Skeleton, Surface, Text, haptic, toast } from '@/ui'

const HUES = {
  dark: ['#93c5fd', '#5eead4', '#c4b5fd', '#fdba74', '#bef264', '#f9a8d4'],
  light: ['#2563eb', '#0d9488', '#7c3aed', '#c2410c', '#4d7c0f', '#be185d'],
}
const KIND: Record<string, string> = { person: 'Person', org: 'Organisation', project: 'Project', place: 'Place', period: 'A chapter of your life', thing: 'Thing' }
const PAD = 40
const MAX_ZOOM = 5

const pct = (v: number) => (v >= 0.995 ? '100%' : v >= 0.1 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`)
const ago = (days?: number) => (days === undefined ? 'never' : days < 1 ? 'today' : days < 2 ? 'yesterday' : `${Math.round(days)} days ago`)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function MemoryMapView({ bottom }: { bottom: number }) {
  const { c, scheme } = useTheme()
  const [data, setData] = useState<GraphData | null | undefined>(undefined)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [picked, setPicked] = useState<number | null>(null)
  const [frames, setFrames] = useState<number[][] | null>(null)
  const [step, setStep] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(() => api<GraphData>('/memory/graph').then(setData, (e: Error) => {
    setData((d) => d ?? null)
    toast({ title: 'Unable to load the map', body: e.message, tone: 'error' })
  }), [])
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

  // layout → screen: fit into the canvas, then the committed zoom and pan
  const at = useMemo(() => {
    if (!map || !size.w) return null
    const xs = map.nodes.map((n) => n.x), ys = map.nodes.map((n) => n.y)
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const sc = Math.min((size.w - 2 * PAD) / Math.max(x1 - x0, 1e-6), (size.h - 2 * PAD) / Math.max(y1 - y0, 1e-6), 120)
    return (x: number, y: number) => [
      size.w / 2 + (x - (x0 + x1) / 2) * sc * view.k + view.x,
      size.h / 2 + (y - (y0 + y1) / 2) * sc * view.k + view.y,
    ] as const
  }, [map, size, view])

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
  // labels: most important (or, while recalling, most reached) first; one that would overlap another is left off
  const labelled = useMemo(() => {
    if (!map || !at) return new Set<number>()
    const order = map.nodes.map((_, i) => i).sort((a, b) => fr
      ? fr[b] - fr[a]
      : (map.nodes[b].mass + 0.2 * map.nodes[b].n) - (map.nodes[a].mass + 0.2 * map.nodes[a].n))
    if (picked !== null) order.unshift(picked)
    const placed: [number, number, number, number][] = [], out = new Set<number>()
    for (const i of order) {
      if (out.has(i)) continue
      const n = map.nodes[i], [x, y] = at(n.x, n.y), r = n.r * Math.sqrt(view.k)
      const w = Math.min(150, n.name.length * 7 + (fr && fr[i] > 0.001 ? 44 : 0))
      const box: [number, number, number, number] = [x - w / 2, y + r + 2, x + w / 2, y + r + 20]
      if (box[2] < 0 || box[0] > size.w || box[3] < 0 || box[1] > size.h) continue
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue
      placed.push(box)
      out.add(i)
    }
    return out
  }, [map, at, fr, picked, size, view.k])

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
  const dim = (i: number) => !!fr && fr[i] <= 0.001

  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: bottom, gap: 12 }}>
      <Surface style={{ flex: 1, overflow: 'hidden' }}>
        <View style={{ flex: 1 }} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
          {at && (
            <GestureDetector gesture={gesture}>
              <Animated.View style={[{ flex: 1 }, live]}>
                <Canvas style={{ width: size.w, height: size.h }}>
                  {map.edges.map((e, i) => {
                    const [ax, ay] = at(map.nodes[e.a].x, map.nodes[e.a].y), [bx, by] = at(map.nodes[e.b].x, map.nodes[e.b].y)
                    const p = Skia.Path.Make()
                    p.moveTo(ax, ay)
                    p.quadTo((ax + bx) / 2 + (ay - by) * 0.08, (ay + by) / 2 + (bx - ax) * 0.08, bx, by)
                    const on = flow ? flow[i] > 1e-4 : false, f = flow ? flow[i] / flowMax : 0
                    return <Path key={i} path={p} style="stroke" strokeCap="round" strokeWidth={0.6 + 1.8 * (e.w / wMax) + (on ? 2 * f : 0)}
                      color={on ? c.tube : c.ink3} opacity={flow ? (on ? 0.25 + 0.75 * f : 0.08) : 0.32} />
                  })}
                  {map.nodes.map((n, i) => {
                    const [x, y] = at(n.x, n.y), v = fr ? fr[i] / top : null
                    return (
                      <Circle key={`g${i}`} cx={x} cy={y} r={n.r * 1.6 * Math.sqrt(view.k)} color={dim(i) ? c.ink4 : hues[n.community % hues.length]}
                        opacity={0.08 + 0.4 * (v === null ? n.recall : v)}>
                        <BlurMask blur={9} style="normal" />
                      </Circle>
                    )
                  })}
                  {map.nodes.map((n, i) => {
                    const [x, y] = at(n.x, n.y), v = fr ? fr[i] / top : null, r = n.r * Math.sqrt(view.k)
                    const color = dim(i) ? c.ink4 : hues[n.community % hues.length]
                    const o = v === null ? 0.4 + 0.6 * n.recall : 0.35 + 0.65 * Math.sqrt(v)
                    // a chapter of your life is a ring: the people and things in it sit around it
                    return n.kind === 'period'
                      ? <Circle key={`c${i}`} cx={x} cy={y} r={r} color={color} opacity={o} style="stroke" strokeWidth={3} />
                      : <Circle key={`c${i}`} cx={x} cy={y} r={r} color={color} opacity={o} />
                  })}
                  {/* what memory isn't sure of yet: faint satellites around their entry (agent mem.py tentative facts) */}
                  {map.nodes.flatMap((n, i) => Array.from({ length: Math.min(n.unsure, 6) }, (_, j) => {
                    const [x, y] = at(n.x, n.y), r = n.r * Math.sqrt(view.k) + 7, a = -Math.PI / 2 + (j * 2 * Math.PI) / Math.min(n.unsure, 6)
                    return <Circle key={`u${i}-${j}`} cx={x + r * Math.cos(a)} cy={y + r * Math.sin(a)} r={2.5} color={c.ink2} opacity={dim(i) ? 0.2 : 0.55} />
                  }))}
                  {sel && (() => { const [x, y] = at(sel.x, sel.y); return <Circle cx={x} cy={y} r={sel.r * Math.sqrt(view.k) + 4} color={c.tube} style="stroke" strokeWidth={1.5} /> })()}
                </Canvas>
                {map.nodes.map((n, i) => {
                  const [x, y] = at(n.x, n.y), r = n.r * Math.sqrt(view.k)
                  const share = fr && fr[i] > 0.001 ? ` · ${pct(fr[i])}` : ''
                  return (
                    <Press key={n.id} radius={22} static onPress={() => { haptic.tap(); setPicked(i === picked ? null : i) }}
                      accessibilityLabel={`${n.name}, ${KIND[n.kind] ?? n.kind}, ${n.facts} facts`}
                      outerStyle={{ position: 'absolute', left: x - 75, top: y - Math.max(22, r), width: 150 }} style={{ alignItems: 'center' }}>
                      <View style={{ height: Math.max(44, r * 2) }} />
                      {labelled.has(i) && (
                        <Text variant="footnote" numberOfLines={1} align="center" color={dim(i) ? 'ink3' : 'ink'}
                          style={{ marginTop: -Math.max(0, 22 - r) + 2, textShadowColor: c.panel, textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } }}>
                          {n.name}{share}
                        </Text>
                      )}
                    </Press>
                  )
                })}
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
