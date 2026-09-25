import { View } from 'react-native'

import type { Teammate } from '@/lib/types'
import { useTheme } from '@/theme'

import { TeammateAvatar } from './avatar'
import { Text } from './text'

export interface AvatarStackProps {
  teammates: Pick<Teammate, 'id' | 'avatar_shape' | 'color' | 'name'>[]
  size?: number
  max?: number
  /** Teammate ids with a live run. */
  working?: Set<string>
}

/** Overlapping teammate faces (project members). Shows `+n` past `max`. */
export function AvatarStack({ teammates, size = 24, max = 3, working }: AvatarStackProps) {
  const { c } = useTheme()
  const shown = teammates.slice(0, max)
  const rest = teammates.length - shown.length
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center' }}
      accessible
      accessibilityLabel={teammates.map((t) => t.name).join(', ')}
    >
      {shown.map((t, i) => (
        <View key={t.id} style={{ marginLeft: i === 0 ? 0 : -size * 0.28, zIndex: shown.length - i }}>
          <TeammateAvatar teammate={t} size={size} interactive={false} state={working?.has(t.id) ? 'working' : 'default'} />
        </View>
      ))}
      {rest > 0 && (
        <View style={{ marginLeft: -size * 0.2, height: size * 0.8, minWidth: size * 0.8, paddingHorizontal: 4, borderRadius: size, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.canvas }}>
          <Text variant="footnote" tabular color="ink2" style={{ fontSize: 10, lineHeight: 12 }}>+{rest}</Text>
        </View>
      )}
    </View>
  )
}
