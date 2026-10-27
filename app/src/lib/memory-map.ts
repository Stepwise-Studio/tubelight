// The memory map's maths (docs/memory-v3.html §6), on the phone so recall can play live. The server (agent
// mem.graph) sends entities, how many episodes each came up in, co-occurrence counts and when each was used.
//   edges      PPMI: max(0, ln(n_ab·N / (n_a·n_b)))                                  eq. 6
//   distance   shortest path, edge length ½ + 1/(½ + PPMI)
//   layout     stress majorization (Gansner, Koren, North 2004), turned onto its long axis   eq. 9
//   regions    Louvain, level 1 (local moves that raise modularity)
//   brightness ACT-R recall probability from use times, d = 0.5, τ = −1, s = 0.4            eq. 4–5
//   recall     Personalized PageRank from one entity, α = 0.15, every step kept             eq. 7

export interface GraphNode { id: string; name: string; kind: string; n: number; mass: number; facts: number; unsure: number; uses: number[] }
export interface GraphData { episodes: number; nodes: GraphNode[]; edges: { a: string; b: string; n: number }[] }

export interface MapNode extends GraphNode { x: number; y: number; r: number; community: number; recall: number }
export interface MapEdge { a: number; b: number; w: number }
export interface MemoryMap { nodes: MapNode[]; edges: MapEdge[]; stress: number; modularity: number; communities: number }

const ALPHA = 0.15
export const STEPS = 20

/** ACT-R base-level activation → probability of recall (eq. 4–5). Uses are days ago. */
export function recallProbability(daysAgo: number[]): number {
  if (!daysAgo.length) return 0
  const sum = daysAgo.reduce((a, d) => a + Math.max(d, 1 / 24) ** -0.5, 0)
  return 1 / (1 + Math.exp(-(Math.log(sum) + 1) / 0.4))
}

export function layout(g: GraphData): MemoryMap {
  const n = g.nodes.length
  const index = new Map(g.nodes.map((x, i) => [x.id, i]))
  const N = Math.max(g.episodes, 1)
  const edges: MapEdge[] = []
  for (const e of g.edges) {
    const a = index.get(e.a), b = index.get(e.b)
    if (a === undefined || b === undefined) continue
    const w = Math.max(0, Math.log((e.n * N) / (g.nodes[a].n * g.nodes[b].n)))
    if (w > 0) edges.push({ a, b, w })
  }
  // graph distances (Floyd–Warshall); apart islands sit about as far as the farthest connected pair
  const INF = 1e9
  const D: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : INF)))
  for (const e of edges) {
    const l = 0.5 + 1 / (0.5 + e.w)
    D[e.a][e.b] = D[e.b][e.a] = Math.min(D[e.a][e.b], l)
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j]
  let far = 0
  for (const row of D) for (const v of row) if (v < INF) far = Math.max(far, v)
  far = Math.max(far, 1.5)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (D[i][j] >= INF) D[i][j] = far * 0.8
  // stress majorization from a deterministic start (a golden-angle spiral)
  const P = Array.from({ length: n }, (_, i) => [Math.cos(i * 2.4) * (1 + i * 0.3), Math.sin(i * 2.4) * (1 + i * 0.3)])
  for (let it = 0; it < 300; it++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sw = 0
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const w = D[i][j] ** -2, dx = P[i][0] - P[j][0], dy = P[i][1] - P[j][1], dist = Math.hypot(dx, dy) || 1e-6
        sx += w * (P[j][0] + (D[i][j] * dx) / dist)
        sy += w * (P[j][1] + (D[i][j] * dy) / dist)
        sw += w
      }
      if (sw) P[i] = [sx / sw, sy / sw]
    }
  }
  // onto the principal axis (stress doesn't change under rotation): the long side runs along the screen's height
  const mx = P.reduce((a, p) => a + p[0], 0) / Math.max(n, 1), my = P.reduce((a, p) => a + p[1], 0) / Math.max(n, 1)
  let sxx = 0, syy = 0, sxy = 0
  for (const [x, y] of P) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my) }
  const th = Math.PI / 2 - 0.5 * Math.atan2(2 * sxy, sxx - syy), c = Math.cos(th), s = Math.sin(th)
  for (let i = 0; i < n; i++) { const x = P[i][0] - mx, y = P[i][1] - my; P[i] = [x * c - y * s, x * s + y * c] }
  let stress = 0
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) stress += (Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]) - D[i][j]) ** 2 / D[i][j] ** 2
  // Louvain, level 1
  const adj = Array.from({ length: n }, () => new Map<number, number>())
  for (const e of edges) { adj[e.a].set(e.b, e.w); adj[e.b].set(e.a, e.w) }
  const k = adj.map((m) => [...m.values()].reduce((a, b) => a + b, 0))
  const m2 = k.reduce((a, b) => a + b, 0) || 1
  const com = Array.from({ length: n }, (_, i) => i), tot = [...k]
  for (let moved = true, pass = 0; moved && pass < 20; pass++) {
    moved = false
    for (let i = 0; i < n; i++) {
      if (!k[i]) continue
      const ci = com[i]
      tot[ci] -= k[i]
      const links = new Map<number, number>()
      adj[i].forEach((w, j) => links.set(com[j], (links.get(com[j]) ?? 0) + w))
      let best = ci, gain = (links.get(ci) ?? 0) - (tot[ci] * k[i]) / m2
      links.forEach((kin, cc) => { const g2 = kin - (tot[cc] * k[i]) / m2; if (g2 > gain + 1e-12) { gain = g2; best = cc } })
      com[i] = best
      tot[best] += k[i]
      if (best !== ci) moved = true
    }
  }
  let modularity = 0
  { const inW = new Map<number, number>(), tt = new Map<number, number>()
    for (const e of edges) if (com[e.a] === com[e.b]) inW.set(com[e.a], (inW.get(com[e.a]) ?? 0) + 2 * e.w)
    for (let i = 0; i < n; i++) tt.set(com[i], (tt.get(com[i]) ?? 0) + k[i])
    tt.forEach((t, cc) => { modularity += (inW.get(cc) ?? 0) / m2 - (t / m2) ** 2 }) }
  // islands of one get their own colour, connected regions share one
  const ids = [...new Set(com)]
  const maxMass = Math.max(...g.nodes.map((x) => x.mass), 0.5)
  return {
    nodes: g.nodes.map((x, i) => ({
      ...x, x: P[i][0], y: P[i][1], community: ids.indexOf(com[i]), recall: recallProbability(x.uses),
      r: 7 + 15 * Math.sqrt(Math.max(x.mass, 0.1) / maxMass), // area ∝ importance
    })),
    edges, stress, modularity, communities: ids.length,
  }
}

/** Personalized PageRank from one entity (eq. 7): every step, so recall can be played and scrubbed. */
export function spread(map: MemoryMap, from: number): number[][] {
  const n = map.nodes.length
  const adj = Array.from({ length: n }, () => [] as { j: number; w: number }[])
  for (const e of map.edges) { adj[e.a].push({ j: e.b, w: e.w }); adj[e.b].push({ j: e.a, w: e.w }) }
  const deg = adj.map((l) => l.reduce((a, x) => a + x.w, 0))
  const seed: number[] = Array.from({ length: n }, (_, i) => (i === from ? 1 : 0))
  let pi = [...seed]
  const frames = [pi]
  for (let s = 0; s < STEPS; s++) {
    const next = seed.map((v) => ALPHA * v)
    for (let j = 0; j < n; j++) {
      if (!deg[j]) { next[j] += (1 - ALPHA) * pi[j]; continue }
      for (const { j: i, w } of adj[j]) next[i] += ((1 - ALPHA) * pi[j] * w) / deg[j]
    }
    pi = next
    frames.push(pi)
  }
  return frames
}

// ------------------------------------------------------------------ drawing rules (shared with the off-device preview)
// Calm colours: one muted hue per group, no glow. Brightness is fill opacity only, and every node keeps a full-opacity
// ring, so a memory that has faded is quieter but never invisible.
export const HUES = {
  dark: ['#7ea6d8', '#62b3a8', '#a092d6', '#d29f6c', '#a3be72', '#cf92b4'],
  light: ['#3a6db3', '#2b857a', '#6a5bbd', '#ad682b', '#5c8530', '#ad4f7d'],
}
export const fillOpacity = (recall: number) => 0.22 + 0.63 * recall

export const LABEL_H = 20
export const LABEL_PAD = 8  // each side
const LABEL_MAX_W = 140
/** A pill's width for a label whose text measures `textW` (Inter Display 12, measured with the real font: widths run
 *  from under 4 to over 10 px a character, so no estimate is safe). The pill clips anything longer, so the box placed is
 *  the box drawn and two labels can never overlap. */
export const labelWidth = (textW: number) => Math.min(LABEL_MAX_W, Math.ceil(textW) + 2 * LABEL_PAD + 2)

export interface LabelBox { i: number; x: number; y: number; w: number }
type Box = [number, number, number, number]
const hits = (a: Box, b: Box) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/** Labels for the nodes in `order` (most deserving first), at most `budget` of them: each tries below, above, right,
 *  left of its node, then on it, and takes the first spot that overlaps no other label and no other node's middle, and
 *  stays on screen. */
export function placeLabels(pts: { x: number; y: number; r: number }[], textW: number[], order: number[],
  size: { w: number; h: number }, budget: number): LabelBox[] {
  // a label may cross another node's rim, never its middle: every node stays visible, and a hub in a crowd still
  // finds room for its name
  const discs: Box[] = pts.map((p) => { const k = Math.max(4, p.r * 0.55); return [p.x - k, p.y - k, p.x + k, p.y + k] })
  const placed: Box[] = [], out: LabelBox[] = []
  for (const i of order) {
    if (out.length >= budget) break
    const { x, y, r } = pts[i], w = labelWidth(textW[i]), H = LABEL_H
    // below, above, right, left; last, on its own disc (a crowded hub still gets its name)
    const spots: [number, number][] = [[x - w / 2, y + r + 3], [x - w / 2, y - r - 3 - H], [x + r + 5, y - H / 2], [x - r - 5 - w, y - H / 2],
      [x - w / 2, y - H / 2]]
    for (const [lx, ly] of spots) {
      const box: Box = [lx, ly, lx + w, ly + H]
      if (box[0] < 4 || box[1] < 4 || box[2] > size.w - 4 || box[3] > size.h - 4) continue
      if (placed.some((p) => hits(box, p)) || discs.some((d, j) => j !== i && hits(box, d))) continue
      placed.push(box)
      out.push({ i, x: lx, y: ly, w })
      break
    }
  }
  return out
}

/** Nudges overlapping nodes apart on screen (they keep `gap` px between rims), staying inside the frame. The layout
 *  places centres by association distance and never looked at sizes, so big nodes sat on top of each other. Positions
 *  move only as far as overlaps need; the reported stress is the layout's, before this. */
export function separate(pts: { x: number; y: number; r: number }[], size: { w: number; h: number }, gap = 4) {
  const p = pts.map((q) => ({ ...q }))
  for (let it = 0; it < 60; it++) {
    let moved = false
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) {
        const dx = p[j].x - p[i].x, dy = p[j].y - p[i].y, d = Math.hypot(dx, dy) || 1e-3, need = p[i].r + p[j].r + gap
        if (d >= need) continue
        const push = (need - d) / 2, ux = dx / d, uy = dy / d
        p[i].x -= ux * push; p[i].y -= uy * push; p[j].x += ux * push; p[j].y += uy * push
        moved = true
      }
    }
    for (const q of p) { q.x = Math.min(size.w - q.r - 2, Math.max(q.r + 2, q.x)); q.y = Math.min(size.h - q.r - 2, Math.max(q.r + 2, q.y)) }
    if (!moved) break
  }
  return p
}
