import { View } from 'react-native'

import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Squircle, TeammateAvatar } from '@/ui'

/** A DM shows the teammate's face; a project shows two members stacked on a squircle tile. */
export function ThreadAvatar({ threadId, size = 48, interactive = false }: { threadId: string; size?: number; interactive?: boolean }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const people = ws.threadTeammates(threadId)
  if (threadId.startsWith('dm:')) {
    const t = people[0]
    if (!t) return <View style={{ width: size, height: size }} />
    return <TeammateAvatar teammate={t} size={size} interactive={interactive} state={ws.isWorking(t.id) ? 'working' : 'default'} />
  }
  const small = Math.round(size * 0.62)
  const [a, b] = people
  return (
    <Squircle style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line }}>
      {a && <View style={{ position: 'absolute', left: size * 0.06, top: size * 0.04 }}><TeammateAvatar teammate={a} size={small} interactive={false} state={ws.isWorking(a.id) ? 'working' : 'default'} /></View>}
      {b && <View style={{ position: 'absolute', right: size * 0.04, bottom: size * 0.02 }}><TeammateAvatar teammate={b} size={small} interactive={false} state={ws.isWorking(b.id) ? 'working' : 'default'} /></View>}
    </Squircle>
  )
}
