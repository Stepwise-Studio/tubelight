// Draws a teammate's ```openui block (OpenUI Lang, openui.com) with native components. OpenUI's own React Renderer
// wraps everything in DOM <div>s, so we use its parser (lang-core) and map the parsed tree here: one function per
// component in spec.ts. Parsing is permissive and works on a half-streamed block, so the card fills in as it arrives.
import { createLibrary, createParser, type ElementNode } from '@openuidev/lang-core'
import { Component, createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg'

import { fonts, radius, useTheme, type Palette } from '@/theme'
import { Button, Chip, Markdown, Squircle, Surface, Text, haptic } from '@/ui'

import { SPECS } from './spec'

const parser = createParser(createLibrary({ components: SPECS, root: 'Card' }).toJSONSchema(), 'Card')

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'accent' | undefined
type Props = Record<string, unknown>

const Ctx = createContext<{ streaming: boolean; onChoose?: (text: string) => void }>({ streaming: false })

/** A teammate's drawing. `source` is the block's body (without the fence); `streaming` while it is still arriving. */
export function GenUI({ source, streaming, onChoose }: { source: string; streaming: boolean; onChoose?: (text: string) => void }) {
  const root = useMemo(() => { try { return parser.parse(source).root } catch { return null } }, [source])
  if (!root) return null
  return (
    <Ctx.Provider value={{ streaming, onChoose }}>
      <Boundary>{node(root)}</Boundary>
    </Ctx.Provider>
  )
}

/** Keeps the last good drawing if a half-streamed (or malformed) one fails to render. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  last: ReactNode = null
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(prev: { children: ReactNode }) { if (this.state.failed && prev.children !== this.props.children) this.setState({ failed: false }) }
  render() {
    if (this.state.failed) return this.last
    this.last = this.props.children
    return this.props.children
  }
}

const isEl = (v: unknown): v is ElementNode => !!v && typeof v === 'object' && (v as ElementNode).type === 'element'
const arr = <T,>(v: unknown, keep: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(keep) : [])
const els = (v: unknown, type?: string) => arr(v, isEl).filter((e) => !type || e.typeName === type)
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

function node(n: unknown, key?: number): ReactNode {
  if (typeof n === 'string') return n.trim() ? <Markdown key={key} value={n} /> : null
  if (!isEl(n)) return null
  const C = BLOCKS[n.typeName]
  return C ? <C key={key} p={n.props} /> : null
}

// Charts: the accent first, then hues that read on both canvases.
const HUES = ['#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#64748b']
const hue = (c: Palette, i: number) => (i === 0 ? c.tube : HUES[(i - 1) % HUES.length])
const toneColor = (c: Palette, t: Tone) =>
  t === 'good' ? c.success : t === 'bad' ? c.danger : t === 'warn' ? c.warning : t === 'accent' ? c.tube : c.ink3

/** A value with its unit (a symbol like ₹ goes first). `compact` (axes, bar tops) shortens thousands to "k". */
function fmt(v: number, unit?: string, compact = false) {
  const n = compact && Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : v.toLocaleString('en-IN', { maximumFractionDigits: 1 })
  if (!unit) return n
  return /^[^\w\s%]$/u.test(unit) ? `${unit}${n}` : `${n}${unit}`
}

/** A nice upper bound for an axis (1, 2, 2.5 or 5 × 10ⁿ). */
function ceilNice(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p
}

function useWidth() {
  const [w, setW] = useState(0)
  return [w, (e: { nativeEvent: { layout: { width: number } } }) => setW(Math.round(e.nativeEvent.layout.width))] as const
}

function Legend({ names }: { names: string[] }) {
  const { c } = useTheme()
  if (names.length < 2) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {names.map((n, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: hue(c, i) }} />
          <Text variant="footnote" color="ink2">{n}</Text>
        </View>
      ))}
    </View>
  )
}

function series(p: Props) {
  return els(p.series, 'Series').map((s) => ({ name: str(s.props.name), values: arr(s.props.values, (x): x is number => typeof x === 'number') }))
}

const H = 168
const AXIS = 22  // room for x labels under the plot

function BarChart({ p }: { p: Props }) {
  const { c } = useTheme()
  const [w, onLayout] = useWidth()
  const labels = arr(p.labels, (x): x is string => typeof x === 'string').slice(0, 12)
  const all = series(p)
  const unit = str(p.unit) || undefined
  const stacked = p.stacked === true
  const totals = labels.map((_, i) => all.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0))
  const peak = stacked ? Math.max(0, ...totals) : Math.max(0, ...all.flatMap((s) => s.values.slice(0, labels.length)))
  const top = ceilNice(peak)
  const yw = 34
  const plot = H - AXIS
  const slot = labels.length ? (w - yw) / labels.length : 0
  const groups = stacked ? 1 : Math.max(1, all.length)
  const bw = Math.min(28, Math.max(4, (slot * 0.62) / groups))
  const showValues = all.length === 1 && labels.length <= 8
  return (
    <View style={{ gap: 10 }}>
      <View onLayout={onLayout} style={{ height: H }}>
        {w > 0 && (
          <Svg width={w} height={H}>
            {[0, 0.5, 1].map((f) => (
              <G key={f}>
                <Line x1={yw} x2={w} y1={plot - f * (plot - 14)} y2={plot - f * (plot - 14)} stroke={c.line} strokeWidth={1} />
                <SvgText x={yw - 6} y={plot - f * (plot - 14) + 4} fontSize={10} fill={c.ink3} textAnchor="end" fontFamily={fonts.regular}>{fmt(top * f, unit, true)}</SvgText>
              </G>
            ))}
            {labels.map((l, i) => {
              const cx = yw + slot * i + slot / 2
              let base = plot
              return (
                <G key={i}>
                  {all.map((s, j) => {
                    const v = Math.max(0, s.values[i] ?? 0)
                    const h = (v / top) * (plot - 14)
                    const x = stacked ? cx - bw / 2 : cx - (bw * groups) / 2 + j * bw
                    const y = stacked ? base - h : plot - h
                    if (stacked) base -= h
                    return <Rect key={j} x={x + (stacked ? 0 : 1)} y={y} width={Math.max(1, bw - (stacked ? 0 : 2))} height={Math.max(h, v > 0 ? 2 : 0)} rx={Math.min(4, bw / 3)} fill={hue(c, j)} />
                  })}
                  {showValues && (all[0].values[i] ?? null) !== null && (
                    <SvgText x={cx} y={plot - ((Math.max(0, all[0].values[i]) / top) * (plot - 14)) - 5} fontSize={10} fill={c.ink2} textAnchor="middle" fontFamily={fonts.medium}>{fmt(all[0].values[i], unit, true)}</SvgText>
                  )}
                  <SvgText x={cx} y={H - 6} fontSize={10.5} fill={c.ink3} textAnchor="middle" fontFamily={fonts.regular}>{l.length > 7 && labels.length > 5 ? `${l.slice(0, 6)}…` : l}</SvgText>
                </G>
              )
            })}
          </Svg>
        )}
      </View>
      <Legend names={all.map((s) => s.name)} />
    </View>
  )
}

function LineChart({ p }: { p: Props }) {
  const { c } = useTheme()
  const [w, onLayout] = useWidth()
  const labels = arr(p.labels, (x): x is string => typeof x === 'string').slice(0, 30)
  const all = series(p)
  const unit = str(p.unit) || undefined
  const vals = all.flatMap((s) => s.values.slice(0, labels.length))
  const lo = Math.min(0, ...vals)
  const top = ceilNice(Math.max(0, ...vals) - lo) + lo
  const yw = 34
  const plot = H - AXIS
  const x = (i: number) => yw + 6 + (labels.length > 1 ? (i * (w - yw - 12)) / (labels.length - 1) : (w - yw) / 2)
  const y = (v: number) => plot - ((v - lo) / (top - lo || 1)) * (plot - 14)
  const ticks = labels.length <= 6 ? labels.map((_, i) => i) : [0, Math.floor((labels.length - 1) / 2), labels.length - 1]
  return (
    <View style={{ gap: 10 }}>
      <View onLayout={onLayout} style={{ height: H }}>
        {w > 0 && (
          <Svg width={w} height={H}>
            <Defs>
              <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={c.tube} stopOpacity={0.22} />
                <Stop offset="1" stopColor={c.tube} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {[0, 0.5, 1].map((f) => (
              <G key={f}>
                <Line x1={yw} x2={w} y1={plot - f * (plot - 14)} y2={plot - f * (plot - 14)} stroke={c.line} strokeWidth={1} />
                <SvgText x={yw - 6} y={plot - f * (plot - 14) + 4} fontSize={10} fill={c.ink3} textAnchor="end" fontFamily={fonts.regular}>{fmt(lo + (top - lo) * f, unit, true)}</SvgText>
              </G>
            ))}
            {all.map((s, j) => {
              const pts = s.values.slice(0, labels.length).map((v, i) => [x(i), y(v)] as const)
              if (!pts.length) return null
              const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ')
              const last = pts[pts.length - 1]
              return (
                <G key={j}>
                  {all.length === 1 && pts.length > 1 && <Path d={`${d} L${last[0]},${plot} L${pts[0][0]},${plot} Z`} fill="url(#fill)" />}
                  <Path d={d} stroke={hue(c, j)} strokeWidth={2.25} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                  <Circle cx={last[0]} cy={last[1]} r={3.5} fill={hue(c, j)} />
                </G>
              )
            })}
            {ticks.map((i) => (
              <SvgText key={i} x={x(i)} y={H - 6} fontSize={10.5} fill={c.ink3} textAnchor={i === 0 && labels.length > 1 ? 'start' : i === labels.length - 1 && labels.length > 1 ? 'end' : 'middle'} fontFamily={fonts.regular}>{labels[i]}</SvgText>
            ))}
          </Svg>
        )}
      </View>
      <Legend names={all.map((s) => s.name)} />
    </View>
  )
}

function Donut({ p }: { p: Props }) {
  const { c } = useTheme()
  const slices = els(p.slices, 'Slice').slice(0, 7).map((s) => ({ label: str(s.props.label), value: Math.max(0, num(s.props.value)) }))
  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  const unit = str(p.unit) || undefined
  const size = 132
  const sw = 16
  const r = (size - sw) / 2
  const circ = 2 * Math.PI * r
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((a, x) => a + (x.value / total) * circ, 0))
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size} height={size} style={{ position: 'absolute' }}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.panel2} strokeWidth={sw} fill="none" />
          <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
            {slices.map((s, i) => {
              const len = (s.value / total) * circ
              const gap = slices.length > 1 ? Math.min(3, len / 2) : 0
              const el = <Circle key={i} cx={size / 2} cy={size / 2} r={r} stroke={hue(c, i)} strokeWidth={sw} fill="none" strokeDasharray={`${Math.max(0, len - gap)} ${circ}`} strokeDashoffset={-starts[i]} />
              return el
            })}
          </G>
        </Svg>
        {!!str(p.center) && <Text variant="headline" align="center" tabular style={{ maxWidth: size - sw * 2 - 8 }} numberOfLines={2}>{str(p.center)}</Text>}
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        {slices.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: hue(c, i) }} />
            <Text variant="caption" color="ink2" numberOfLines={1} style={{ flex: 1 }}>{s.label}</Text>
            <Text variant="label" tabular>{fmt(s.value, unit)}</Text>
            <Text variant="footnote" color="ink3" tabular style={{ width: 34, textAlign: 'right' }}>{Math.round((s.value / total) * 100)}%</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

function Stats({ p }: { p: Props }) {
  const { c } = useTheme()
  const items = els(p.items, 'Stat').slice(0, 4)
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((s, i) => (
        <Squircle key={i} style={{ flexGrow: 1, flexBasis: items.length === 4 ? '45%' : 0, minWidth: 92, borderRadius: radius.md, backgroundColor: c.panel2, padding: 12, gap: 2 }}>
          <Text variant="footnote" color="ink3" numberOfLines={1}>{str(s.props.label)}</Text>
          <Text variant="heading" tabular numberOfLines={1} adjustsFontSizeToFit>{str(s.props.value)}</Text>
          {!!str(s.props.change) && <Text variant="footnote" numberOfLines={2} style={{ color: toneColor(c, s.props.tone as Tone) }}>{str(s.props.change)}</Text>}
        </Squircle>
      ))}
    </View>
  )
}

function Table({ p }: { p: Props }) {
  const { c } = useTheme()
  const cols = arr(p.columns, (x): x is string => typeof x === 'string')
  const rows = arr(p.rows, (x): x is unknown[] => Array.isArray(x))
  const cw = cols.length <= 3 ? undefined : 112
  const numeric = cols.map((_, j) => rows.length > 0 && rows.every((r) => typeof r[j] === 'number'))  // right-aligned, header too
  const row = (cells: unknown[], head: boolean, i: number) => (
    <View key={i} style={{ flexDirection: 'row', borderTopWidth: head || i === 0 ? 0 : 1, borderColor: c.line, paddingVertical: 8 }}>
      {cols.map((_, j) => (
        <Text key={j} variant={head ? 'label' : 'caption'} color={head ? 'ink3' : j === 0 ? 'ink' : 'ink2'} tabular
          numberOfLines={3} style={{ width: cw, flex: cw ? undefined : 1, paddingRight: 10, textAlign: j > 0 && numeric[j] ? 'right' : 'left' }}>
          {typeof cells[j] === 'number' ? fmt(cells[j] as number) : str(cells[j])}
        </Text>
      ))}
    </View>
  )
  const body = (
    <View style={{ minWidth: '100%' }}>
      <View style={{ borderBottomWidth: 1, borderColor: c.lineStrong }}>{row(cols, true, 0)}</View>
      {rows.map((r, i) => row(r, false, i))}
    </View>
  )
  return cw ? <ScrollView horizontal showsHorizontalScrollIndicator={false}>{body}</ScrollView> : body
}

function Schedule({ p }: { p: Props }) {
  const { c } = useTheme()
  const events = els(p.events, 'Event')
  return (
    <View style={{ gap: 6 }}>
      {!!str(p.day) && <Text variant="label" color="ink3">{str(p.day)}</Text>}
      {events.map((e, i) => {
        const t = e.props.tone as Tone
        const color = t && t !== 'neutral' ? toneColor(c, t) : c.tube
        return (
          <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'stretch' }}>
            <View style={{ width: 48, paddingTop: 8 }}>
              <Text variant="label" tabular>{str(e.props.start)}</Text>
              {!!str(e.props.end) && <Text variant="footnote" color="ink3" tabular>{str(e.props.end)}</Text>}
            </View>
            <Squircle style={{ flex: 1, flexDirection: 'row', borderRadius: radius.md, backgroundColor: c.panel2, overflow: 'hidden' }}>
              <View style={{ width: 3, backgroundColor: color }} />
              <View style={{ flex: 1, paddingVertical: 8, paddingHorizontal: 10 }}>
                <Text variant="bodyMedium" numberOfLines={2}>{str(e.props.title)}</Text>
                {!!str(e.props.detail) && <Text variant="caption" color="ink3" numberOfLines={2}>{str(e.props.detail)}</Text>}
              </View>
            </Squircle>
          </View>
        )
      })}
    </View>
  )
}

function Timeline({ p }: { p: Props }) {
  const { c } = useTheme()
  const steps = els(p.steps, 'Step')
  return (
    <View>
      {steps.map((s, i) => {
        const st = str(s.props.status) || 'todo'
        const color = st === 'done' ? c.success : st === 'current' ? c.tube : st === 'blocked' ? c.danger : c.ink4
        const lastStep = i === steps.length - 1
        return (
          <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ alignItems: 'center', width: 14 }}>
              <View style={{ marginTop: 4, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: color, backgroundColor: st === 'done' ? color : 'transparent' }} />
              {!lastStep && <View style={{ flex: 1, width: 2, backgroundColor: c.line, marginVertical: 2 }} />}
            </View>
            <View style={{ flex: 1, paddingBottom: lastStep ? 0 : 14 }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
                <Text variant="bodyMedium" color={st === 'todo' ? 'ink2' : 'ink'} style={{ flex: 1 }}>{str(s.props.title)}</Text>
                {!!str(s.props.when) && <Text variant="footnote" color="ink3">{str(s.props.when)}</Text>}
              </View>
              {!!str(s.props.detail) && <Text variant="caption" color="ink3">{str(s.props.detail)}</Text>}
            </View>
          </View>
        )
      })}
    </View>
  )
}

function List({ p }: { p: Props }) {
  const { c } = useTheme()
  const items = els(p.items, 'Item')
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderTopWidth: i ? 1 : 0, borderColor: c.line }}>
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" numberOfLines={2}>{str(it.props.title)}</Text>
            {!!str(it.props.subtitle) && <Text variant="caption" color="ink3" numberOfLines={2}>{str(it.props.subtitle)}</Text>}
          </View>
          {!!str(it.props.trailing) && (
            <Text variant="label" tabular style={{ color: it.props.tone ? toneColor(c, it.props.tone as Tone) : c.ink2 }}>{str(it.props.trailing)}</Text>
          )}
        </View>
      ))}
    </View>
  )
}

function Progress({ p }: { p: Props }) {
  const { c } = useTheme()
  const max = num(p.max) || 100
  const f = Math.min(1, Math.max(0, num(p.value) / max))
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text variant="caption" color="ink2" style={{ flex: 1 }}>{str(p.label)}</Text>
        <Text variant="label" tabular>{max === 100 ? `${Math.round(f * 100)}%` : `${fmt(num(p.value))} / ${fmt(max)}`}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: c.panel3, overflow: 'hidden' }}>
        <View style={{ width: `${f * 100}%`, height: '100%', borderRadius: 3, backgroundColor: f >= 1 ? c.success : c.tube }} />
      </View>
    </View>
  )
}

function Callout({ p }: { p: Props }) {
  const { c } = useTheme()
  const t = p.tone as Tone
  const color = t && t !== 'neutral' ? toneColor(c, t) : c.ink3
  const bg = t === 'good' ? c.successSoft : t === 'bad' ? c.dangerSoft : t === 'warn' ? c.warningSoft : t === 'accent' ? c.tubeSoft : c.panel2
  return (
    <Squircle style={{ flexDirection: 'row', gap: 10, borderRadius: radius.md, backgroundColor: bg, padding: 12 }}>
      <View style={{ width: 3, borderRadius: 2, backgroundColor: color }} />
      <View style={{ flex: 1 }}><Markdown value={str(p.text)} /></View>
    </Squircle>
  )
}

function Choices({ p }: { p: Props }) {
  const { streaming, onChoose } = useContext(Ctx)
  const [picked, setPicked] = useState<string | null>(null)
  const options = arr(p.options, (x): x is string => typeof x === 'string').slice(0, 4)
  if (!onChoose) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => (
        <Chip key={o} label={o} size="lg" selected={picked === o}
          onPress={streaming || picked ? undefined : () => { haptic.tap(); setPicked(o); onChoose(o) }} />
      ))}
    </View>
  )
}

function LinkButton({ p }: { p: Props }) {
  const url = str(p.url)
  if (!/^https?:\/\//i.test(url)) return null
  return <Button label={str(p.label) || 'Open'} variant="soft" size="sm" onPress={() => Linking.openURL(url)} style={{ alignSelf: 'flex-start' }} />
}

function Card({ p }: { p: Props }) {
  const children = Array.isArray(p.children) ? p.children : []
  return (
    <Surface padding={16} style={{ alignSelf: 'stretch' }}>
      <View style={{ gap: 14 }}>
        {(!!str(p.title) || !!str(p.subtitle)) && (
          <View>
            {!!str(p.title) && <Text variant="headline">{str(p.title)}</Text>}
            {!!str(p.subtitle) && <Text variant="caption" color="ink3">{str(p.subtitle)}</Text>}
          </View>
        )}
        {children.map((ch, i) => node(ch, i))}
      </View>
    </Surface>
  )
}

const BLOCKS: Record<string, (x: { p: Props }) => ReactNode> = {
  Card, Stats, BarChart, LineChart, Donut, Table, Schedule, Timeline, List, Progress, Callout, Choices, LinkButton,
  Heading: ({ p }) => <Text variant="headline">{str(p.text)}</Text>,
  Para: ({ p }) => <Markdown value={str(p.text)} />,
}

const FENCE = /^```openui(?:-lang)?\s*\n?/
/** A message part that is a drawing: its body, and whether its closing fence has arrived. */
export function drawing(part: string): { source: string; open: boolean } | null {
  if (!FENCE.test(part)) return null
  const body = part.replace(FENCE, '')
  const end = body.lastIndexOf('```')
  return end >= 0 ? { source: body.slice(0, end), open: false } : { source: body, open: true }
}
