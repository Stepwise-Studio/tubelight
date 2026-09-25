import { type ReactNode } from 'react'
import { View } from 'react-native'

import { Rise } from './motion'
import { Text } from './text'

export interface EmptyStateProps {
  /** What this place is ("No approvals waiting"). */
  title: string
  /** What fills it, in one sentence. */
  body?: string
  /** An illustration slot (e.g. a sleeping TeammateAvatar). No stock art. */
  art?: ReactNode
  /** One clear next action (a Button). */
  action?: ReactNode
}

/** Empty state: what the place is for and one action. Lines rise in with a short stagger. */
export function EmptyState({ title, body, art, action }: EmptyStateProps) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: 32, paddingVertical: 48, gap: 6 }}>
      {art && <Rise index={0} style={{ marginBottom: 12 }}>{art}</Rise>}
      <Rise index={1}><Text variant="headline" align="center" accessibilityRole="header">{title}</Text></Rise>
      {body && <Rise index={2}><Text variant="body" color="ink3" align="center" style={{ maxWidth: 300 }}>{body}</Text></Rise>}
      {action && <Rise index={3} style={{ marginTop: 16 }}>{action}</Rise>}
    </View>
  )
}
