import * as Clipboard from 'expo-clipboard'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import {
  Alert02Icon, ArrowDown01Icon, ArrowRight02Icon, Copy01Icon, FlashIcon, Refresh01Icon,
} from '@hugeicons/core-free-icons'

import { ApprovalCard } from '@/components/approval-card'
import { fullTime } from '@/lib/format'
import type { Teammate } from '@/lib/types'
import type { ChatMessage, Ghost, LiveStatus } from '@/lib/use-thread'
import { useWorkspace } from '@/lib/workspace'
import { motion, radius, useTheme } from '@/theme'
import {
  Button, Collapse, Icon, Markdown, Press, Squircle, TeammateAvatar, Text, ThinkingIndicator, haptic, showMenu, toast, useFlip,
} from '@/ui'

export type ChatItem =
  | { type: 'message'; key: string; m: ChatMessage }
  | { type: 'ghost'; key: string; g: Ghost }
  | { type: 'status'; key: string; s: LiveStatus }

export const AVATAR = 28
export const GUTTER = AVATAR + 10

export function senderOf(item: ChatItem) {
  if (item.type === 'message') {
    const m = item.m
    if (m.kind !== 'text' && m.kind !== 'approval') return 'system'
    return m.sender_type === 'teammate' ? `tm:${m.teammate_id}` : m.sender_type
  }
  return `tm:${item.type === 'ghost' ? item.g.teammate_id : item.s.teammate_id}`
}
export const timeOf = (item: ChatItem) => (item.type === 'message' ? item.m.created_at : new Date().toISOString())

export interface RowContext {
  firstInGroup: boolean
  dayBreak: string | null
  /** Freeze avatars far up the thread. */
  pauseAvatar: boolean
  liveThread: boolean
  approvals: Record<string, import('@/lib/types').Approval>
  onRetryMessage: (m: ChatMessage) => void
  onDiscardMessage: (m: ChatMessage) => void
  onRetryRun: () => void
  onApprovalDecided: () => void
  mentionHandles: Set<string>
}

export function ChatRow({ item, ctx }: { item: ChatItem; ctx: RowContext }) {
  return (
    <View style={{ paddingHorizontal: 12 }}>
      {ctx.dayBreak && <DaySeparator label={ctx.dayBreak} />}
      <Body item={item} ctx={ctx} />
    </View>
  )
}

function DaySeparator({ label }: { label: string }) {
  return (
    <View style={{ alignItems: 'center', paddingTop: 20, paddingBottom: 8 }} accessibilityRole="header">
      <Text variant="footnote" color="ink3">{label}</Text>
    </View>
  )
}

function Body({ item, ctx }: { item: ChatItem; ctx: RowContext }) {
  const ws = useWorkspace()
  if (item.type === 'status') {
    const t = ws.teammate(item.s.teammate_id)
    return (
      <TeammateBlock teammate={t} first={ctx.firstInGroup} paused={false} working>
        <View style={{ paddingVertical: 4 }}><ThinkingIndicator state={item.s.state} label={item.s.label} /></View>
      </TeammateBlock>
    )
  }
  if (item.type === 'ghost') {
    const t = ws.teammate(item.g.teammate_id)
    return (
      <TeammateBlock teammate={t} first={ctx.firstInGroup} paused={false} working>
        <View accessibilityLiveRegion="none"><Markdown value={item.g.text} /></View>
      </TeammateBlock>
    )
  }
  const m = item.m
  switch (m.kind) {
    case 'handoff': return <HandoffRow m={m} />
    case 'event': return <SystemRow icon={FlashIcon} text={m.text || `Event: ${String(m.meta.event_type ?? 'external')}`} />
    case 'error': return <ErrorRow m={m} onRetry={ctx.onRetryRun} />
    case 'approval': {
      const t = ws.teammate(m.teammate_id)
      const a = m.meta.approval_id ? ctx.approvals[m.meta.approval_id] : undefined
      return (
        <TeammateBlock teammate={t} first={ctx.firstInGroup} paused={ctx.pauseAvatar}>
          {m.text ? <View style={{ marginBottom: 8 }}><Markdown value={m.text} /></View> : null}
          {a ? (
            <ApprovalCard approval={a} teammate={t} beam={a.status === 'pending'} onDecided={ctx.onApprovalDecided} />
          ) : (
            <Text variant="caption" color="ink3">Loading the request…</Text>
          )}
        </TeammateBlock>
      )
    }
    default:
      return m.sender_type === 'user'
        ? <UserBubble m={m} first={ctx.firstInGroup} handles={ctx.mentionHandles} onRetry={ctx.onRetryMessage} onDiscard={ctx.onDiscardMessage} />
        : <TeammateText m={m} first={ctx.firstInGroup} paused={ctx.pauseAvatar} />
  }
}

function TeammateBlock({ teammate, first, paused, working, children }: {
  teammate?: Teammate; first: boolean; paused: boolean; working?: boolean; children: React.ReactNode
}) {
  const ws = useWorkspace()
  const live = working || (teammate ? ws.isWorking(teammate.id) : false)
  return (
    <View style={{ marginTop: first ? 14 : 4 }}>
      {first && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          {teammate ? <TeammateAvatar teammate={teammate} size={AVATAR} state={live ? 'working' : 'default'} paused={paused && !live} /> : <View style={{ width: AVATAR }} />}
          <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {teammate?.name ?? 'Former teammate'}
            {teammate && <Text variant="footnote" color="ink3">{`  ${teammate.role}`}</Text>}
          </Text>
        </View>
      )}
      <View style={{ paddingLeft: GUTTER, paddingRight: 8 }}>{children}</View>
    </View>
  )
}

function copyMenu(m: ChatMessage) {
  showMenu({
    title: fullTime(m.created_at),
    items: [{ label: 'Copy text', icon: Copy01Icon, onPress: async () => { await Clipboard.setStringAsync(m.text); toast({ title: 'Copied' }) } }],
  })
}

function TeammateText({ m, first, paused }: { m: ChatMessage; first: boolean; paused: boolean }) {
  const ws = useWorkspace()
  const t = ws.teammate(m.teammate_id)
  const calls = m.meta.tool_calls ?? []
  return (
    <TeammateBlock teammate={t} first={first} paused={paused}>
      {m.proactive && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 }}>
          <Icon icon={FlashIcon} size={13} color="ink3" />
          <Text variant="footnote" color="ink3">Started by an event{m.meta.event_type ? `: ${String(m.meta.event_type)}` : ''}</Text>
        </View>
      )}
      <Pressable onLongPress={() => copyMenu(m)} delayLongPress={350} accessibilityHint="Long press for time and copy">
        <Markdown value={m.text} />
      </Pressable>
      {calls.length > 0 && <ToolCalls calls={calls} />}
    </TeammateBlock>
  )
}

/** Accordion (transitions.dev 21) listing the tools a reply used. */
function ToolCalls({ calls }: { calls: { name: string; status: string }[] }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(false)
  const flip = useFlip(open)
  const label = calls.length === 1 ? 'Used 1 tool' : `Used ${calls.length} tools`
  return (
    <View style={{ marginTop: 6 }}>
      <Press
        radius={8}
        static
        onPress={() => setOpen((o) => !o)}
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        outerStyle={{ alignSelf: 'flex-start', marginLeft: -6 }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 32 }}
      >
        <Text variant="footnote" color="ink3">{label}</Text>
        <Animated.View style={flip}><Icon icon={ArrowDown01Icon} size={14} color="ink3" /></Animated.View>
      </Press>
      <Collapse open={open}>
        <View style={{ gap: 4, paddingBottom: 4 }}>
          {calls.map((call, i) => (
            <View key={`${call.name}-${i}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: call.status === 'error' ? c.danger : c.ink3 }} />
              <Text variant="footnote" color="ink2" numberOfLines={1} style={{ flex: 1 }}>{call.name}</Text>
              <Text variant="footnote" color={call.status === 'error' ? 'danger' : 'ink3'}>{call.status}</Text>
            </View>
          ))}
        </View>
      </Collapse>
    </View>
  )
}

function renderMentions(text: string, handles: Set<string>) {
  return text.split(/(@[a-z0-9][a-z0-9_-]*)/gi).map((part, i) =>
    part.startsWith('@') && handles.has(part.slice(1).toLowerCase())
      ? <Text key={i} variant="bodyMedium" color="tube">{part}</Text>
      : part)
}

function UserBubble({ m, first, handles, onRetry, onDiscard }: {
  m: ChatMessage; first: boolean; handles: Set<string>; onRetry: (m: ChatMessage) => void; onDiscard: (m: ChatMessage) => void
}) {
  const { c } = useTheme()
  return (
    <View style={{ alignItems: 'flex-end', marginTop: first ? 14 : 4 }}>
      <Pressable
        onLongPress={() => copyMenu(m)}
        delayLongPress={350}
        style={{ maxWidth: '82%' }}
        accessibilityLabel={`You: ${m.text}${m.local === 'failed' ? '. Not sent' : ''}`}
      >
        <Squircle style={{ borderRadius: 20, backgroundColor: c.panel2, paddingHorizontal: 14, paddingVertical: 9, opacity: m.local === 'sending' ? 0.6 : 1 }}>
          <Text selectable>{renderMentions(m.text, handles)}</Text>
        </Squircle>
      </Pressable>
      {m.local === 'failed' && (
        <Animated.View entering={FadeIn.duration(motion.duration.quick)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <Icon icon={Alert02Icon} size={14} color="danger" />
          <Text variant="footnote" color="danger">Not sent</Text>
          <Press radius={8} static onPress={() => { haptic.light(); onRetry(m) }} style={{ paddingHorizontal: 8, minHeight: 32, justifyContent: 'center' }}>
            <Text variant="label" color="ink">Retry</Text>
          </Press>
          <Press radius={8} static onPress={() => onDiscard(m)} style={{ paddingHorizontal: 8, minHeight: 32, justifyContent: 'center' }}>
            <Text variant="label" color="ink3">Delete</Text>
          </Press>
        </Animated.View>
      )}
    </View>
  )
}

function HandoffRow({ m }: { m: ChatMessage }) {
  const ws = useWorkspace()
  const from = ws.teammate(m.teammate_id)
  const to = ws.teammate(m.meta.to_teammate_id)
  const note = m.meta.note
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16 }}
      accessible
      accessibilityLabel={`${from?.name ?? 'A teammate'} handed off to ${to?.name ?? 'a teammate'}${note ? `: ${note}` : ''}`}
    >
      {from && <TeammateAvatar teammate={from} size={18} interactive={false} paused />}
      <Text variant="footnote" color="ink2">{from?.name ?? 'Teammate'}</Text>
      <Icon icon={ArrowRight02Icon} size={13} color="ink3" />
      {to && <TeammateAvatar teammate={to} size={18} interactive={false} paused />}
      <Text variant="footnote" color="ink2">{to?.name ?? 'Teammate'}</Text>
      {(note || m.text) && <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>{` · “${note ?? m.text}”`}</Text>}
    </View>
  )
}

function SystemRow({ icon, text }: { icon: typeof FlashIcon; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 16 }}>
      <Icon icon={icon} size={14} color="ink3" />
      <Text variant="footnote" color="ink3" numberOfLines={2} style={{ flexShrink: 1 }}>{text}</Text>
    </View>
  )
}

function ErrorRow({ m, onRetry }: { m: ChatMessage; onRetry: () => void }) {
  const { c } = useTheme()
  return (
    <Squircle style={{ marginTop: 10, marginLeft: GUTTER, borderRadius: radius.md, backgroundColor: c.dangerSoft, paddingLeft: 12, paddingRight: 4, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon icon={Alert02Icon} size={16} color="danger" />
      <Text variant="caption" color="ink2" style={{ flex: 1, paddingVertical: 6 }}>{m.text || 'The run stopped with an error.'}</Text>
      <Button label="Retry" size="sm" variant="ghost" icon={Refresh01Icon} onPress={onRetry} />
    </Squircle>
  )
}
