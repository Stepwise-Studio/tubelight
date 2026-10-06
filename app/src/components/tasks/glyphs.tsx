// Linear's status and priority glyphs, drawn crisp with SVG: a dashed ring for backlog, a ring for todo, a ring with
// a half pie for in progress, a filled check for done, a filled cross for canceled; priority as signal bars, urgent as
// a filled square with "!".
import { memo } from 'react'
import Svg, { Circle, Path, Rect } from 'react-native-svg'

import type { TodoStatus } from '@/lib/tasks'
import { useTheme } from '@/theme'

export const StatusGlyph = memo(function StatusGlyph({ status, size = 18 }: { status: TodoStatus; size?: number }) {
  const { c } = useTheme()
  const r = 6.25
  if (status === 'done' || status === 'canceled') {
    const fill = status === 'done' ? c.tube : c.ink4
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Circle cx={8} cy={8} r={7} fill={fill} />
        {status === 'done'
          ? <Path d="M4.9 8.2 7 10.2 11.1 6" stroke={c.canvas} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          : <Path d="M5.6 5.6 10.4 10.4M10.4 5.6 5.6 10.4" stroke={c.canvas} strokeWidth={1.6} strokeLinecap="round" />}
      </Svg>
    )
  }
  const ring = status === 'doing' ? c.warning : c.ink3
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx={8} cy={8} r={r} stroke={ring} strokeWidth={1.5} fill="none"
        strokeDasharray={status === 'backlog' ? '1.6 1.9' : undefined} strokeLinecap="round" />
      {/* In progress: the right half filled, inset from the ring. */}
      {status === 'doing' && <Path d="M8 3.75 A4.25 4.25 0 0 1 8 12.25 Z" fill={c.warning} />}
    </Svg>
  )
})

export const PriorityGlyph = memo(function PriorityGlyph({ priority, size = 16 }: { priority: number; size?: number }) {
  const { c } = useTheme()
  if (priority === 1) {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Rect x={1.5} y={1.5} width={13} height={13} rx={3.5} fill={c.danger} />
        <Path d="M8 4.6v4.2" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />
        <Circle cx={8} cy={11.2} r={1} fill="#fff" />
      </Svg>
    )
  }
  if (!priority) {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        {[3, 7, 11].map((x) => <Rect key={x} x={x} y={7.25} width={2.5} height={1.5} rx={0.75} fill={c.ink4} />)}
      </Svg>
    )
  }
  const lit = priority === 2 ? 3 : priority === 3 ? 2 : 1
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      {[0, 1, 2].map((i) => (
        <Rect key={i} x={2 + i * 4.5} y={10 - i * 3.5} width={3} height={4 + i * 3.5} rx={1} fill={i < lit ? c.ink2 : c.ink4} opacity={i < lit ? 1 : 0.45} />
      ))}
    </Svg>
  )
})
