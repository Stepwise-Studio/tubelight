import { router } from 'expo-router'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Add01Icon, Delete02Icon, Edit02Icon, MessageMultiple01Icon } from '@hugeicons/core-free-icons'

import { isUnread, plainText, relativeTime } from '@/lib/format'
import type { Thread } from '@/lib/types'
import { chatTitle, isExtraChat, useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Button, IconButton, Press, Sheet, Text, TextField, confirm, haptic, showMenu, toast } from '@/ui'

/** The header button of a DM: its chats with this teammate (a dot when another one has something new). */
export function ChatsButton({ teammateId, threadId, onPress }: { teammateId: string; threadId: string; onPress: () => void }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const elsewhere = ws.chatsWith(teammateId).some((t) => t.id !== threadId && (isUnread(t) || ws.isThreadLive(t.id)))
  return (
    <View>
      <IconButton icon={MessageMultiple01Icon} round accessibilityLabel={`Chats${elsewhere ? ', something new in another chat' : ''}`} onPress={onPress} />
      {elsewhere && <View pointerEvents="none" style={{ position: 'absolute', top: 9, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: c.tube, borderWidth: 1.5, borderColor: c.canvas }} />}
    </View>
  )
}

const open = (id: string) => router.replace({ pathname: '/chat/[threadId]', params: { threadId: id } })

/**
 * Every chat with one teammate: switch, start a new one, rename or delete (long press). The teammate reads the
 * others' briefs in each one, so asking here about another chat works.
 */
export function ChatsSheet({ open: shown, onClose, teammateId, threadId, name }: {
  open: boolean; onClose: () => void; teammateId: string; threadId: string; name: string
}) {
  const ws = useWorkspace()
  const chats = ws.chatsWith(teammateId)
  const [renaming, setRenaming] = useState<Thread | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const close = () => { setRenaming(null); onClose() }

  const create = async () => {
    // An untouched new chat is reused instead of piling up empty ones.
    const empty = chats.find((t) => isExtraChat(t.id) && !t.last_message_at)
    setBusy(true)
    try {
      const id = empty?.id ?? await ws.newChat(teammateId)
      haptic.success()
      close()
      if (id !== threadId) open(id)
    } catch (e) {
      toast({ title: 'Unable to start a chat', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  const rename = (t: Thread) => { setValue(t.title ?? ''); setRenaming(t) }
  const remove = async (t: Thread) => {
    if (!await confirm({ title: 'Delete this chat?', body: `“${chatTitle(t)}” and its messages are deleted. ${name} keeps what it learned in memory.`, confirmLabel: 'Delete chat', destructive: true })) return
    if (t.id === threadId) open(chats.find((x) => x.id !== t.id)?.id ?? `dm:${teammateId}`)
    await ws.deleteChat(t.id)
    toast({ title: 'Chat deleted' })
  }

  if (renaming) {
    const save = async () => { await ws.renameChat(renaming.id, value.trim()); haptic.success(); setRenaming(null) }
    return (
      <Sheet open={shown} onClose={close} title="Rename chat">
        <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 14 }}>
          <TextField label="Name" value={value} onChangeText={setValue} autoFocus selectTextOnFocus maxLength={60}
            placeholder={chatTitle({ ...renaming, title: null })} returnKeyType="done" onSubmitEditing={save} />
          <Button label="Rename" fullWidth size="lg" onPress={save} />
        </View>
      </Sheet>
    )
  }

  return (
    <Sheet open={shown} onClose={close} title={`Chats with ${name}`}>
      <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}>
        <Button label="New chat" icon={Add01Icon} fullWidth loading={busy} onPress={create} style={{ marginHorizontal: 8, marginBottom: 12 }} />
        {chats.map((t) => <ChatItem key={t.id} t={t} current={t.id === threadId} name={name}
          onPress={() => { close(); if (t.id !== threadId) open(t.id) }}
          onLongPress={() => showMenu({
            title: chatTitle(t),
            items: [
              { label: 'Rename', icon: Edit02Icon, onPress: () => rename(t) },
              ...(isExtraChat(t.id) ? [{ label: 'Delete chat', icon: Delete02Icon, destructive: true, onPress: () => remove(t) }] : []),
            ],
          })} />)}
      </ScrollView>
    </Sheet>
  )
}

function ChatItem({ t, current, name, onPress, onLongPress }: { t: Thread; current: boolean; name: string; onPress: () => void; onLongPress: () => void }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const p = ws.previews[t.id]
  const live = ws.isThreadLive(t.id)
  const unread = !current && isUnread(t)
  const sub = live ? `${name} is working` : p ? (p.sender_type === 'user' ? 'You: ' : '') + plainText(p.text) : 'No messages yet'
  return (
    <Press radius={14} static onPress={onPress} onLongPress={onLongPress}
      accessibilityLabel={`${chatTitle(t)}${current ? ', open now' : ''}${unread ? ', unread' : ''}. ${sub}`}
      accessibilityHint="Opens this chat. Long press to rename or delete"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 10, backgroundColor: current ? c.panel2 : undefined }}>
      {/* The open chat is lit: a short tube glowing at its edge. */}
      <View style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: current ? c.tube : 'transparent', marginRight: -4 }} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>{chatTitle(t)}</Text>
          <View style={{ flex: 1 }} />
          {(p || t.last_message_at) && <Text variant="footnote" tabular color={unread ? 'tube' : 'ink3'}>{relativeTime(p?.created_at ?? t.last_message_at!)}</Text>}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="caption" color={live ? 'tube' : unread ? 'ink2' : 'ink3'} numberOfLines={1} style={{ flex: 1 }}>{sub}</Text>
          {unread && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.tube }} accessibilityElementsHidden />}
        </View>
      </View>
    </Press>
  )
}
