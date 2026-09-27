// The Memory graph: people, companies and topics as nodes, linked when a memory mentions them together.
import { useMemo } from 'react'
import { View, useWindowDimensions } from 'react-native'
import Svg, { Circle, G, Line, Text as SvgText } from 'react-native-svg'

import type { MemoryItem } from '@/lib/types'
import { useTheme } from '@/theme'

export interface Entity { id: string; label: string; items: MemoryItem[] }

const HUB = '__you__'

/** Entities from the memories' `about` names (case-insensitive), with co-mention links. */
export function entitiesOf(items: MemoryItem[]) {
  const nodes = new Map<string, Entity>()
  const links = new Map<string, number>()
  for (const m of items) {
    const ids = [...new Set(m.about.map((a) => a.trim()).filter(Boolean).map((a) => a.toLowerCase()))]
    for (const [i, id] of ids.entries()) {
      const label = m.about.find((a) => a.trim().toLowerCase() === id)!.trim()
      const e = nodes.get(id) ?? { id, label, items: [] }
      e.items.push(m)
      nodes.set(id, e)
      for (const other of ids.slice(i + 1)) {
        const k = [id, other].sort().join('|')
        links.set(k, (links.get(k) ?? 0) + 1)
      }
    }
  }
  return { nodes: [...nodes.values()], links: [...links.entries()].map(([k, w]) => ({ a: k.split('|')[0], b: k.split('|')[1], w })) }
}

/**
 * Force layout (Fruchterman-Reingold), run once per data change. Every entity also hangs loosely off a
 * "You" hub so separate clusters stay on screen.
 * ponytail: O(n²) per step, fine to a few hundred nodes; switch to a quadtree (Barnes-Hut) past that.
 */
function layout(nodes: Entity[], links: { a: string; b: string; w: number }[], size: number) {
  const ids = [HUB, ...nodes.map((n) => n.id)]
  const pos = new Map(ids.map((id, i) => {
    const angle = (i / ids.length) * Math.PI * 2
    const r = id === HUB ? 0 : size * 0.3
    return [id, { x: size / 2 + r * Math.cos(angle), y: size / 2 + r * Math.sin(angle) }]
  }))
  const edges = [...links, ...nodes.map((n) => ({ a: HUB, b: n.id, w: 0.25 }))]
  const k = Math.sqrt((size * size) / Math.max(ids.length, 1)) * 0.75
  let temp = size / 8
  for (let step = 0; step < 220; step++) {
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]))
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = pos.get(ids[i])!, q = pos.get(ids[j])!
        const dx = p.x - q.x, dy = p.y - q.y
        const d = Math.max(Math.hypot(dx, dy), 0.01)
        const f = (k * k) / d
        const di = disp.get(ids[i])!, dj = disp.get(ids[j])!
        di.x += (dx / d) * f; di.y += (dy / d) * f
        dj.x -= (dx / d) * f; dj.y -= (dy / d) * f
      }
    }
    for (const e of edges) {
      const p = pos.get(e.a)!, q = pos.get(e.b)!
      const dx = p.x - q.x, dy = p.y - q.y
      const d = Math.max(Math.hypot(dx, dy), 0.01)
      const f = ((d * d) / k) * Math.min(e.w, 3)
      const da = disp.get(e.a)!, db = disp.get(e.b)!
      da.x -= (dx / d) * f; da.y -= (dy / d) * f
      db.x += (dx / d) * f; db.y += (dy / d) * f
    }
    for (const id of ids) {
      if (id === HUB) continue
      const p = pos.get(id)!, d = disp.get(id)!
      const len = Math.max(Math.hypot(d.x, d.y), 0.01)
      p.x = Math.min(size - 24, Math.max(24, p.x + (d.x / len) * Math.min(len, temp)))
      p.y = Math.min(size - 24, Math.max(24, p.y + (d.y / len) * Math.min(len, temp)))
    }
    temp *= 0.97
  }
  return pos
}

export function MemoryGraph({ items, onOpen }: { items: MemoryItem[]; onOpen: (e: Entity) => void }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const size = Math.min(width - 32, 560)
  const { nodes, links } = useMemo(() => entitiesOf(items), [items])
  const pos = useMemo(() => layout(nodes, links, size), [nodes, links, size])
  const hub = pos.get(HUB)!
  const labelAll = nodes.length <= 24

  return (
    <View style={{ width: size, height: size, alignSelf: 'center' }} accessibilityLabel={`Memory graph: ${nodes.length} people and topics`}>
      <Svg width={size} height={size}>
        {nodes.map((n) => {
          const p = pos.get(n.id)!
          return <Line key={`hub-${n.id}`} x1={hub.x} y1={hub.y} x2={p.x} y2={p.y} stroke={c.line} strokeWidth={0.75} strokeDasharray="2 4" />
        })}
        {links.map((l) => {
          const a = pos.get(l.a)!, b = pos.get(l.b)!
          return <Line key={`${l.a}|${l.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c.lineStrong} strokeWidth={Math.min(1 + l.w * 0.6, 3)} />
        })}
        <Circle cx={hub.x} cy={hub.y} r={14} fill={c.tube} />
        <SvgText x={hub.x} y={hub.y + 28} fill={c.ink} fontSize={12} fontWeight="600" textAnchor="middle">You</SvgText>
        {nodes.map((n) => {
          const p = pos.get(n.id)!
          const r = 5 + Math.sqrt(n.items.length) * 3.5
          const person = n.items.some((m) => m.kind === 'person')
          const owed = n.items.some((m) => m.kind === 'commitment' && !m.done)
          return (
            <G key={n.id} onPress={() => onOpen(n)}>
              <Circle cx={p.x} cy={p.y} r={r + 10} fill="transparent" />
              <Circle cx={p.x} cy={p.y} r={r} fill={owed ? c.warning : person ? c.ink : c.ink3} stroke={c.panel} strokeWidth={2} />
              {(labelAll || n.items.length > 1) && (
                <SvgText x={p.x} y={p.y + r + 13} fill={c.ink2} fontSize={11} textAnchor="middle">{n.label}</SvgText>
              )}
            </G>
          )
        })}
      </Svg>
    </View>
  )
}
