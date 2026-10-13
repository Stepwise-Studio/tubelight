// Status and priority glyphs, Linear's shapes, drawn with SVG: backlog a dashed grey ring, todo a grey ring, in
// progress a yellow ring with its pie half filled, done a green disc with a check, canceled a rose disc with a cross;
// priority as signal bars, urgent as an orange square with "!". A teammate (assignee) is a face.
import { memo } from 'react'
import Svg, { Circle, Path, Rect } from 'react-native-svg'

import type { TodoStatus } from '@/lib/tasks'
import { useTheme } from '@/theme'

/** The same in both themes. */
export const LINEAR = {
  backlog: '#95a2b3', todo: '#a3a3a3', doing: '#f2c94c', done: '#22a55b', canceled: '#f43f5e', urgent: '#f2994a',
} as const

export const StatusGlyph = memo(function StatusGlyph({ status, size = 18 }: { status: TodoStatus; size?: number }) {
  const { scheme } = useTheme()
  const ink = '#ffffff'
  if (status === 'done' || status === 'canceled') {
    return (
      <Svg width={size} height={size} viewBox="0 0 14 14">
        <Circle cx={7} cy={7} r={6} fill={LINEAR[status]} />
        {status === 'done'
          ? <Path d="M4.3 7.1 6.1 8.9 9.7 5.2" stroke={ink} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          : <Path d="M5 5 9 9M9 5 5 9" stroke={ink} strokeWidth={1.4} strokeLinecap="round" />}
      </Svg>
    )
  }
  const ring = status === 'doing' ? LINEAR.doing : status === 'backlog' ? LINEAR.backlog : (scheme === 'dark' ? '#b4b4b8' : '#8a8a8f')
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      <Circle cx={7} cy={7} r={5.6} stroke={ring} strokeWidth={1.5} fill="none"
        strokeDasharray={status === 'backlog' ? '1.4 1.7' : undefined} />
      {/* In progress: the pie fills from 12 o'clock clockwise, half way. */}
      {status === 'doing' && <Path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill={LINEAR.doing} />}
    </Svg>
  )
})

export const PriorityGlyph = memo(function PriorityGlyph({ priority, size = 16 }: { priority: number; size?: number }) {
  const { scheme } = useTheme()
  const on = scheme === 'dark' ? '#d0d0d4' : '#5b5b62'
  const off = scheme === 'dark' ? '#4a4a50' : '#c8c8cd'
  if (priority === 1) {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        <Rect x={1} y={1} width={14} height={14} rx={3.5} fill={LINEAR.urgent} />
        <Path d="M8 4.2v4.6" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" />
        <Circle cx={8} cy={11.4} r={1.05} fill="#fff" />
      </Svg>
    )
  }
  if (!priority) {
    return (
      <Svg width={size} height={size} viewBox="0 0 16 16">
        {[2.5, 6.75, 11].map((x) => <Rect key={x} x={x} y={7.25} width={2.5} height={1.5} rx={0.75} fill={off} />)}
      </Svg>
    )
  }
  const lit = priority === 2 ? 3 : priority === 3 ? 2 : 1
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      {[0, 1, 2].map((i) => (
        <Rect key={i} x={1.5 + i * 5} y={10 - i * 3.5} width={3} height={4.5 + i * 3.5} rx={1} fill={i < lit ? on : off} />
      ))}
    </Svg>
  )
})
