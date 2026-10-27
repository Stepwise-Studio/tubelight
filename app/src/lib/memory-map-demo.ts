// Sample data for the memory map (Memory → Map with ?demo=map, and the off-device preview): an invented user's world,
// 34 people, projects and places in five groups, with co-occurrence counts chosen so PPMI links form inside groups and a
// few bridges between them. Nothing here is real; it exists so the map can be judged with a full screen of nodes.
import type { GraphData, GraphNode } from './memory-map'

const GROUPS: [string, string][][] = [
  [['Data Science course', 'project'], ['Course project', 'project'], ['Prof. Menon', 'person'], ['Tara', 'person'],
    ['Vikram Rao', 'person'], ['Online degree', 'org'], ['Entrance exam', 'project']],
  [['Lantern Labs', 'org'], ['Beacon app', 'project'], ['Farhan', 'person'], ['Kavya Iyer', 'person'], ['Paylane', 'org'],
    ['Nikhil (Paylane)', 'person'], ['Investor deck', 'project'], ['Demo day', 'project']],
  [['Amma', 'person'], ['Appa', 'person'], ['Divya', 'person'], ['Chennai', 'place'], ['Grandma', 'person'],
    ['Home renovation', 'project']],
  [['Rahul', 'person'], ['Sneha', 'person'], ['Goa trip', 'project'], ['Arjun Mehta', 'person'], ['Bangalore', 'place'],
    ['College friends', 'org'], ['Wedding in March', 'period']],
  [['Gym', 'place'], ['Coach Ravi', 'person'], ['Cricket club', 'org'], ['Half marathon', 'project'], ['Physio', 'person'],
    ['Summer 2026', 'period']],
]
// a few people and projects that also come up with another group
const BRIDGES: [string, string, number][] = [
  ['Course project', 'Beacon app', 6], ['Tara', 'Rahul', 4], ['Divya', 'Wedding in March', 9], ['Chennai', 'Grandma', 7],
  ['Farhan', 'Cricket club', 5], ['Demo day', 'Entrance exam', 3], ['Bangalore', 'Lantern Labs', 6],
  ['Summer 2026', 'Course project', 5], ['Amma', 'Wedding in March', 6],
]

function rng(seed: number) {  // mulberry32: the same sample every time
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function demoGraph(): GraphData {
  const r = rng(7)
  const nodes: GraphNode[] = []
  const edges: GraphData['edges'] = []
  GROUPS.forEach((g, gi) => {
    g.forEach(([name, kind], j) => {
      const n = Math.round((j === 0 ? 90 : 18 + r() * 50) * (gi === 1 ? 1.3 : 1))  // the first of a group is its hub
      const used = Math.floor(r() * 6)
      nodes.push({
        id: `d${gi}-${j}`, name, kind, n, mass: j === 0 ? 6 + r() * 3 : 0.6 + r() * 4, facts: 1 + Math.floor(r() * 9),
        unsure: r() < 0.3 ? 1 + Math.floor(r() * 3) : 0,
        uses: Array.from({ length: used }, () => r() * (gi === 2 ? 120 : 30)),  // family: used less lately
      })
    })
    for (let a = 0; a < g.length; a++) {
      for (let b = a + 1; b < g.length; b++) {
        if (a === 0 || r() < 0.45) edges.push({ a: `d${gi}-${a}`, b: `d${gi}-${b}`, n: 3 + Math.floor(r() * 10) })
      }
    }
  })
  const id = (name: string) => nodes.find((x) => x.name === name)!.id
  for (const [a, b, n] of BRIDGES) edges.push({ a: id(a), b: id(b), n })
  return { episodes: 900, nodes, edges }
}
