// Memory: everything the teammates have learned about you, your people and your work. List or graph.
import { useCallback, useEffect, useState } from 'react'
import { FlatList, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CheckmarkCircle02Icon, Delete02Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons'

import { MemoryGraph, entitiesOf, type Entity } from '@/components/memory-graph'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import { ago } from '@/lib/format'
import type { MemoryItem } from '@/lib/types'
import {
  Button, Checkbox, Chip, type ChipColor, Dialog, EmptyState, Press, SearchField, Segment, Sheet, Skeleton, Surface, Text,
  TextField, haptic, showMenu, toast,
} from '@/ui'

type Kind = MemoryItem['kind']
const KIND: Record<Kind, { label: string; plural: string; color: ChipColor }> = {
  commitment: { label: 'To do', plural: 'To do', color: 'warning' },
  person: { label: 'Person', plural: 'People', color: 'info' },
  preference: { label: 'Preference', plural: 'Preferences', color: 'magical' },
  lesson: { label: 'Lesson', plural: 'Lessons', color: 'success' },
  fact: { label: 'Fact', plural: 'Facts', color: 'idle' },
}
const ORDER: Kind[] = ['commitment', 'person', 'preference', 'lesson', 'fact']

const shelf = (m: MemoryItem) => ({ scope: m.scope, id: m.scope_id, key: m.key })
const whose = (m: MemoryItem) => (m.scope === 'user' ? 'All teammates' : m.scope === 'teammate' ? m.scope_name : `${m.scope_name} project`)

export default function MemoryScreen() {
  const insets = useSafeAreaInsets()
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [view, setView] = useState<'list' | 'graph'>('list')
  const [kind, setKind] = useState<Kind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [entity, setEntity] = useState<Entity | null>(null)
  const [editing, setEditing] = useState<MemoryItem | null>(null)

  const load = useCallback(() => api<MemoryItem[]>('/memories/all').then(setItems, (e: Error) => {
    setItems((l) => l ?? [])
    toast({ title: 'Unable to load memory', body: e.message, tone: 'error' })
  }), [])
  useEffect(() => { load() }, [load])

  const patch = async (m: MemoryItem, change: { text?: string; done?: boolean }) => {
    setItems((l) => l?.map((x) => (x.key === m.key ? { ...x, ...change } : x)) ?? l)
    try { await api('/memories', { method: 'PATCH', json: { ...shelf(m), ...change } }) } catch (e) {
      toast({ title: 'Unable to save that change', body: (e as Error).message, tone: 'error' })
      load()
    }
  }
  const remove = async (m: MemoryItem) => {
    setItems((l) => l?.filter((x) => x.key !== m.key) ?? l)
    setEntity((e) => (e ? { ...e, items: e.items.filter((x) => x.key !== m.key) } : e))
    try {
      await api(`/memories?scope=${m.scope}&id=${m.scope_id}&key=${encodeURIComponent(m.key)}`, { method: 'DELETE' })
      toast({ title: 'Forgotten', body: m.text })
    } catch (e) {
      toast({ title: 'Unable to delete that', body: (e as Error).message, tone: 'error' })
      load()
    }
  }
  const actions = { onToggle: (m: MemoryItem) => { haptic.tap(); patch(m, { done: !m.done }) }, onEdit: setEditing, onDelete: remove }

  const q = query.trim().toLowerCase()
  const counts = Object.fromEntries(ORDER.map((k) => [k, (items ?? []).filter((m) => m.kind === k && !(k === 'commitment' && m.done)).length]))
  const shown = (items ?? [])
    .filter((m) => kind === 'all' || m.kind === kind)
    .filter((m) => !q || m.text.toLowerCase().includes(q) || m.about.some((a) => a.toLowerCase().includes(q)))
    // open to-dos first, then newest
    .sort((a, b) => Number(b.kind === 'commitment' && !b.done) - Number(a.kind === 'commitment' && !a.done))

  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Memory" subtitle="What your teammates have learned" />
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 12 }}>
        <Segment value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'graph', label: 'Graph' }]} accessibilityLabel="Show memory as" />
      </View>
      {items === null ? (
        <View style={{ padding: 16, gap: 12 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} radius={16} />)}
        </View>
      ) : items.length === 0 ? (
        <EmptyState title="Nothing learned yet" body="Chat with a teammate. The people, to-dos and preferences that matter stick here on their own." />
      ) : view === 'graph' ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}>
          {entitiesOf(items).nodes.length === 0 ? (
            <EmptyState title="No people or topics yet" body="As teammates learn who you work with and what about, they show up here, linked." />
          ) : (
            <>
              <MemoryGraph items={items} onOpen={setEntity} />
              <Text variant="caption" color="ink3" align="center">
                Tap a dot to see what they know. Amber has an open to-do; linked dots were mentioned together.
              </Text>
            </>
          )}
        </ScrollView>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(m) => m.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          ListHeaderComponent={
            <View style={{ gap: 12, paddingTop: 12, paddingBottom: 12 }}>
              <SearchField value={query} onChangeText={setQuery} placeholder="Search memory" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
                <Chip label={`All ${items.length}`} selected={kind === 'all'} onPress={() => setKind('all')} />
                {ORDER.filter((k) => counts[k]).map((k) => (
                  <Chip key={k} label={`${KIND[k].plural} ${counts[k]}`} selected={kind === k} onPress={() => setKind(k)} />
                ))}
              </ScrollView>
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          renderItem={({ item }) => <MemoryCard m={item} {...actions} />}
          ListEmptyComponent={<Text variant="caption" color="ink3" style={{ padding: 8 }}>Nothing matches.</Text>}
        />
      )}

      <Sheet open={!!entity} onClose={() => setEntity(null)} title={entity?.label ?? ''}>
        <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
          {entity?.items.map((m) => <MemoryCard key={m.key} m={m} {...actions} />)}
        </ScrollView>
      </Sheet>
      <EditDialog item={editing} onClose={() => setEditing(null)} onSave={(m, text) => patch(m, { text })} />
    </View>
  )
}

function MemoryCard({ m, onToggle, onEdit, onDelete }: {
  m: MemoryItem
  onToggle: (m: MemoryItem) => void
  onEdit: (m: MemoryItem) => void
  onDelete: (m: MemoryItem) => void
}) {
  const todo = m.kind === 'commitment'
  const menu = () => showMenu({
    message: m.text,
    items: [
      ...(todo ? [{ label: m.done ? 'Mark as not done' : 'Mark as done', icon: CheckmarkCircle02Icon, onPress: () => onToggle(m) }] : []),
      { label: 'Edit', icon: PencilEdit02Icon, onPress: () => onEdit(m) },
      { label: 'Forget this', icon: Delete02Icon, destructive: true, onPress: () => onDelete(m) },
    ],
  })
  return (
    <Surface style={{ overflow: 'hidden' }}>
      <Press radius={16} static onPress={menu} onLongPress={menu} accessibilityLabel={`${KIND[m.kind].label}: ${m.text}`} accessibilityHint="Opens actions"
        style={{ flexDirection: 'row', gap: 12, padding: 14 }}>
        {todo && <View style={{ paddingTop: 1 }}><Checkbox value={m.done} onChange={() => onToggle(m)} /></View>}
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="body" color={m.done ? 'ink3' : 'ink'} style={m.done ? { textDecorationLine: 'line-through' } : undefined}>{m.text}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Chip label={KIND[m.kind].label} color={KIND[m.kind].color} variant="soft" size="sm" />
            {m.due && !m.done && <Chip label={`Due ${m.due}`} color="warning" dot size="sm" />}
            <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>
              {[whose(m), ago(m.updated_at)].join(' · ')}
            </Text>
          </View>
        </View>
      </Press>
    </Surface>
  )
}

function EditDialog({ item, onClose, onSave }: { item: MemoryItem | null; onClose: () => void; onSave: (m: MemoryItem, text: string) => void }) {
  const [text, setText] = useState('')
  useEffect(() => { if (item) setText(item.text) }, [item]) // eslint-disable-line react-hooks/set-state-in-effect
  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title="Edit memory"
      actions={
        <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Save" disabled={!text.trim()} onPress={() => { if (item) onSave(item, text.trim()); onClose() }} />
        </View>
      }
    >
      <TextField value={text} onChangeText={setText} multiline accessibilityLabel="Memory" maxLength={500} />
    </Dialog>
  )
}

