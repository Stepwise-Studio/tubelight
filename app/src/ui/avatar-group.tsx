// Stepwise UI's AvatarGroup (ui.stepwise.studio/docs/avatar): an overlapping stack (32% of the size, plus half the
// ring's 3 px padding, which on the web takes no space), each avatar ringed in the
// background it sits on (3 px) so the overlaps read, the first one on top; past `max`, a "+n" circle.
// Anything round goes in it: teammates' faces (AvatarStack below), app logos, photos.
import type { ReactNode } from 'react'
import { View } from 'react-native'

import type { Teammate } from '@/lib/types'
import { useTheme } from '@/theme'

import { TeammateAvatar } from './avatar'
import { Text } from './text'

export interface AvatarGroupItem { key: string; name: string; render: (size: number) => ReactNode }

export function AvatarGroup({ items, size = 28, max = 5, ring }: {
  items: AvatarGroupItem[]; size?: number; max?: number
  /** The colour behind the group (default: the page). */
  ring?: string
}) {
  const { c } = useTheme()
  const shown = items.slice(0, max)
  const rest = items.length - shown.length
  const edge = ring ?? c.canvas
  const cell = (key: string, i: number, z: number, child: ReactNode) => (
    <View key={key} style={{ marginLeft: i === 0 ? 0 : -size * 0.32 - 3, zIndex: z, padding: 3, borderRadius: size, backgroundColor: edge }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>{child}</View>
    </View>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', margin: -3 }} accessible accessibilityLabel={items.map((x) => x.name).join(', ')}>
      {shown.map((x, i) => cell(x.key, i, shown.length - i + 1, x.render(size)))}
      {rest > 0 && cell('+', shown.length, 0, (
        <View style={{ flex: 1, alignSelf: 'stretch', backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="label" color="ink2" tabular style={{ fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.5) }}>+{rest}</Text>
        </View>
      ))}
    </View>
  )
}

/** Teammates' faces as an AvatarGroup (project members, the inbox's crew, your profile). */
export function AvatarStack({ teammates, size = 24, max = 3, working, ring }: {
  teammates: Pick<Teammate, 'id' | 'avatar_shape' | 'color' | 'name'>[]
  size?: number; max?: number; ring?: string
  /** Teammate ids with a live run. */
  working?: Set<string>
}) {
  return (
    <AvatarGroup size={size} max={max} ring={ring} items={teammates.map((t) => ({
      key: t.id, name: t.name,
      render: (s) => <TeammateAvatar teammate={t} size={s} interactive={false} state={working?.has(t.id) ? 'working' : 'default'} />,
    }))} />
  )
}
