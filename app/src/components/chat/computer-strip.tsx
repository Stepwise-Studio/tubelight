// The strip under a computer's chat header: is it online, battery, disk, memory; and one-tap slash commands.
import { ScrollView, View } from 'react-native'

import { useTheme } from '@/theme'
import { Chip, Text } from '@/ui'

export interface ComputerInfo {
  online: boolean
  last_seen: number | null
  stats: { disk?: number; mem?: number; load?: number; battery?: number; charging?: boolean }
}

const QUICK = [
  { label: 'Status', cmd: '/status' },
  { label: 'Biggest', cmd: '/big' },
  { label: 'Clean up', cmd: '/clean' },
  { label: 'What’s running', cmd: '/top' },
  { label: 'Lock', cmd: '/lock' },
]

export function ComputerStrip({ pc, onCommand }: { pc: ComputerInfo | null; onCommand: (cmd: string) => void }) {
  const { c } = useTheme()
  if (!pc) return null
  const s = pc.stats ?? {}
  const facts = pc.online ? [
    s.battery != null && `Battery ${s.battery}%${s.charging ? ' · plugged in' : ''}`,
    s.disk != null && `Disk ${s.disk}%`,
    s.mem != null && `Memory ${s.mem}%`,
  ].filter(Boolean).join('  ·  ') : 'Offline: Tubelight isn’t running on it'
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: c.line, paddingVertical: 8, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: pc.online ? c.success : c.ink4 }} />
        <Text variant="footnote" color="ink2" numberOfLines={1} style={{ flex: 1 }} tabular>{facts}</Text>
      </View>
      {pc.online && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {QUICK.map((q) => <Chip key={q.cmd} label={q.label} size="sm" onPress={() => onCommand(q.cmd)} />)}
        </ScrollView>
      )}
    </View>
  )
}
