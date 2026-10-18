// Memory → Map: the people, projects and places memory holds, drawn from numbers memory computes (lib/memory-map.ts):
// size = importance, brightness = how recallable right now, fibre = how much more often two come up together than
// chance, distance = how related. Tap one to see it; "Recall from here" plays the real spreading activation.
import { BlurMask, Canvas, Circle, Path, Skia } from '@shopify/react-native-skia'
import { router } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native'

import { api } from '@/lib/api'
import { type GraphData, type MemoryMap, STEPS, layout, spread } from '@/lib/memory-map'
import { useTheme } from '@/theme'
import { Button, EmptyState, Press, Skeleton, Surface, Text, haptic, toast } from '@/ui'

const HUES = {
  dark: ['#93c5fd', '#5eead4', '#c4b5fd', '#fdba74', '#bef264', '#f9a8d4'],
  light: ['#2563eb', '#0d9488', '#7c3aed', '#c2410c', '#4d7c0f', '#be185d'],
}
const KIND: Record<string, string> = { person: 'Person', org: 'Organisation', project: 'Project', place: 'Place', thing: 'Thing' }
const PAD = 48

const pct = (v: number) => (v >= 0.995 ? '100%' : v >= 0.1 ? `${Math.round(v * 100)}%` : `${(v * 100).toFixed(1)}%`)
const ago = (days?: number) => (days === undefined ? 'never' : days < 1 ? 'today' : days < 2 ? 'yesterday' : `${Math.round(days)} days ago`)

export function MemoryMapView({ bottom }: { bottom: number }) {
  const { c, scheme } = useTheme()
  const { width: screen, height: tall } = useWindowDimensions()
  const width = screen - 32
  const HEIGHT = Math.round(Math.min(440, Math.max(300, tall * 0.42)))  // leaves room for the card under it
  const [data, setData] = useState<GraphData | null | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
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

  // fit the layout into the canvas
  const fit = useMemo(() => {
    if (!map) return null
    const xs = map.nodes.map((n) => n.x), ys = map.nodes.map((n) => n.y)
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const sc = Math.min((width - 2 * PAD) / Math.max(x1 - x0, 1e-6), (HEIGHT - 2 * PAD) / Math.max(y1 - y0, 1e-6), 120)
    return (x: number, y: number) => [width / 2 + (x - (x0 + x1) / 2) * sc, HEIGHT / 2 + (y - (y0 + y1) / 2) * sc] as const
  }, [map, width, HEIGHT])

  const stop = () => { if (timer.current) clearInterval(timer.current); timer.current = null }
  const play = (from: number) => {
    if (!map) return
    stop()
    haptic.tap()
    const f = spread(map, from)
    setFrames(f)
    setStep(0)
    let s = 0
    timer.current = setInterval(() => {
      s += 1
      setStep(s)
      if (s >= STEPS) stop()
    }, 300)
  }
  const reset = () => { stop(); setFrames(null); setStep(0) }

  if (data === undefined) return <View style={{ padding: 16 }}><Skeleton height={HEIGHT} radius={20} /></View>
  if (data === null) return <EmptyState title="The map isn't available" body="Pull down on Overview to try again." />
  if (!map || !fit) {
    return <EmptyState title="Your map is empty so far" body="As people, projects and places come up in your chats, they appear here, linked by how often they come up together." />
  }

  const fr = frames?.[step]
  const top = fr ? Math.max(...fr) : 1
  const flow = fr ? map.edges.map((e) => fr[e.a] * e.w + fr[e.b] * e.w) : null
  const flowMax = flow ? Math.max(...flow, 1e-9) : 1
  const wMax = Math.max(...map.edges.map((e) => e.w), 1e-9)
  const sel = picked !== null ? map.nodes[picked] : null
  const from = frames ? frames[0].indexOf(1) : -1
  const ranked = fr ? fr.map((v, i) => [v, i] as const).filter(([v, i]) => i !== from && v > 0.001).sort((a, b) => b[0] - a[0]).slice(0, 5) : []

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: bottom, gap: 14 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); reset(); await load(); setRefreshing(false) }} />}>
      <Surface style={{ height: HEIGHT, overflow: 'hidden' }}>
        <Canvas style={{ width, height: HEIGHT }}>
          {map.edges.map((e, i) => {
            const [ax, ay] = fit(map.nodes[e.a].x, map.nodes[e.a].y), [bx, by] = fit(map.nodes[e.b].x, map.nodes[e.b].y)
            const p = Skia.Path.Make()
            p.moveTo(ax, ay)
            p.quadTo((ax + bx) / 2 + (ay - by) * 0.08, (ay + by) / 2 + (bx - ax) * 0.08, bx, by)
            const on = flow ? flow[i] > 1e-4 : false
            const f = flow ? flow[i] / flowMax : 0
            return <Path key={i} path={p} style="stroke" strokeCap="round" strokeWidth={0.8 + 2.2 * (e.w / wMax) + (on ? 2 * f : 0)}
              color={on ? c.tube : c.ink3} opacity={flow ? (on ? 0.25 + 0.75 * f : 0.12) : 0.45} />
          })}
          {map.nodes.map((n, i) => {
            const [x, y] = fit(n.x, n.y)
            const v = fr ? fr[i] / top : null
            const lit = v === null ? n.recall : v
            const color = v !== null && fr![i] <= 0.001 ? c.ink4 : hues[n.community % hues.length]
            return (
              <Circle key={`g${i}`} cx={x} cy={y} r={n.r * 1.7} color={color} opacity={0.1 + 0.45 * lit}>
                <BlurMask blur={10} style="normal" />
              </Circle>
            )
          })}
          {map.nodes.map((n, i) => {
            const [x, y] = fit(n.x, n.y)
            const v = fr ? fr[i] / top : null
            const color = v !== null && fr![i] <= 0.001 ? c.ink4 : hues[n.community % hues.length]
            return <Circle key={`c${i}`} cx={x} cy={y} r={n.r} color={color} opacity={v === null ? 0.4 + 0.6 * n.recall : 0.35 + 0.65 * Math.sqrt(v)} />
          })}
          {sel && (() => { const [x, y] = fit(sel.x, sel.y); return <Circle cx={x} cy={y} r={sel.r + 4} color={c.tube} style="stroke" strokeWidth={1.5} /> })()}
        </Canvas>
        {map.nodes.map((n, i) => {
          const [x, y] = fit(n.x, n.y)
          const share = fr && fr[i] > 0.001 ? ` · ${pct(fr[i])}` : ''
          return (
            <Press key={n.id} radius={22} static onPress={() => { haptic.tap(); setPicked(i === picked ? null : i) }}
              accessibilityLabel={`${n.name}, ${KIND[n.kind] ?? n.kind}, ${n.facts} facts`}
              outerStyle={{ position: 'absolute', left: x - 80, top: y - Math.max(22, n.r), width: 160 }} style={{ alignItems: 'center' }}>
              <View style={{ height: Math.max(44, n.r * 2) }} />
              <Text variant="label" numberOfLines={2} align="center" color={fr && fr[i] <= 0.001 ? 'ink3' : 'ink'}
                style={{ textShadowColor: c.panel, textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } }}>{n.name}{share}</Text>
            </Press>
          )
        })}
      </Surface>

      {frames ? (
        <Surface style={{ padding: 14, gap: 10 }}>
          <Text variant="label" color="ink3">Recalling from {map.nodes[from].name} · step {step} of {STEPS}</Text>
          <Text variant="body" color="ink2">
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
              {[KIND[sel.kind] ?? sel.kind, `${sel.facts} ${sel.facts === 1 ? 'fact' : 'facts'}`, sel.unsure ? `${sel.unsure} not sure yet` : null,
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
          <Text variant="label" color="ink3">How to read it</Text>
          <Text variant="caption" color="ink2">{"Size is how much their facts matter. Brightness is how readily it would come to mind now: use brightens it, time dims it. A line means two come up together more often than chance, and nearer means more related. Colours are groups that belong together. You aren't a dot: you're in almost everything, so you're the space they sit in."}</Text>
          <Text variant="caption" color="ink3" tabular>
            {`${map.nodes.length} people and things · ${map.edges.length} links · ${map.communities} groups · layout error ${map.stress.toFixed(2)}`}
          </Text>
          <Text variant="caption" color="ink3">Tap one to see it, then play how recall spreads from it.</Text>
        </Surface>
      )}
    </ScrollView>
  )
}
