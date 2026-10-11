// Memory (Profile → Open memory): what the teammates know. Overview: you and how you like things, what's open, what
// was learned lately and where from, and how far learning has got. People: everyone and everything known, each with
// its own page. Lessons: each teammate's how-to notes (and older notes from before memory v2).
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CheckmarkCircle02Icon, Delete02Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons'

import { PeopleList, PersonMark, heardFrom } from '@/components/people'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import { ago, shortDate } from '@/lib/format'
import type { MemoryItem, MemoryOverview, OverviewFact } from '@/lib/types'
import { useTheme } from '@/theme'
import {
  Button, Checkbox, Chip, type ChipColor, Dialog, EmptyState, Press, SearchField, SectionHeader, Segment, Skeleton, Squircle,
  Surface, Text, TextField, haptic, showMenu, toast,
} from '@/ui'

type Kind = MemoryItem['kind']
const KIND: Record<Kind, { label: string; plural: string; color: ChipColor }> = {
  commitment: { label: 'To do', plural: 'To do', color: 'warning' },
  person: { label: 'Person', plural: 'People', color: 'info' },
  preference: { label: 'Preference', plural: 'Preferences', color: 'magical' },
  lesson: { label: 'Lesson', plural: 'Lessons', color: 'success' },
  fact: { label: 'Fact', plural: 'Facts', color: 'idle' },
}

const shelf = (m: MemoryItem) => ({ scope: m.scope, id: m.scope_id, key: m.key })
const whose = (m: MemoryItem) => (m.scope === 'user' ? 'All teammates' : m.scope === 'teammate' ? m.scope_name : `${m.scope_name} project`)

export default function MemoryScreen() {
  const insets = useSafeAreaInsets()
  const [view, setView] = useState<'overview' | 'people' | 'lessons'>('overview')
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeader title="Memory" subtitle="What your teammates know, and where they learned it" />
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <Segment value={view} onChange={setView} accessibilityLabel="Show"
          options={[{ value: 'overview', label: 'Overview' }, { value: 'people', label: 'People' }, { value: 'lessons', label: 'Lessons' }]} />
      </View>
      {view === 'overview' ? <Overview bottom={insets.bottom + 32} onPeople={() => setView('people')} />
        : view === 'people' ? <PeopleList bottom={insets.bottom + 24} />
          : <Lessons bottom={insets.bottom + 24} />}
    </View>
  )
}

function Overview({ bottom, onPeople }: { bottom: number; onPeople: () => void }) {
  const { c } = useTheme()
  const [o, setO] = useState<MemoryOverview | null | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const load = useCallback(() => api<MemoryOverview>('/memory/overview').then(setO, (e: Error) => {
    setO((x) => x ?? null)
    toast({ title: 'Unable to load memory', body: e.message, tone: 'error' })
  }), [])
  useEffect(() => { load() }, [load])
  // while it's still reading history, check back now and then so the progress moves
  useEffect(() => {
    if (!o?.counts.waiting) return
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [o?.counts.waiting, load])

  if (o === undefined) {
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <Skeleton height={120} radius={16} />
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={56} radius={12} />)}
      </View>
    )
  }
  if (o === null) return <EmptyState title="Memory isn't available" body="Pull down to try again." />
  const n = o.counts
  if (!n.facts && !n.waiting) {
    return <EmptyState title="Nothing learned yet" body="Chat with a teammate. The people, to-dos and preferences that matter show up here, each with where it came from." />
  }
  const done = n.episodes - n.waiting
  const open = (f: OverviewFact) => router.push(`/person/${f.entity}`)

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: bottom, gap: 28 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
    >
      <View style={{ gap: 8 }}>
        <Text variant="caption" color="ink3" tabular>
          {[`${n.facts} ${n.facts === 1 ? 'fact' : 'facts'}`, `${n.people} ${n.people === 1 ? 'person or thing' : 'people and things'}`,
            n.last_learned ? `last learned ${ago(n.last_learned)}` : null].filter(Boolean).join(' · ')}
        </Text>
        {n.waiting > 0 && (
          <View style={{ gap: 6 }}>
            <Text variant="footnote" color="ink2" tabular>Reading {n.waiting} more {n.waiting === 1 ? 'message' : 'messages'} from your chats</Text>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: c.panel2, overflow: 'hidden' }}>
              <View style={{ height: 4, borderRadius: 2, width: `${Math.max(4, (done / Math.max(1, n.episodes)) * 100)}%`, backgroundColor: c.tube }} />
            </View>
          </View>
        )}
      </View>

      <Press radius={16} static onPress={() => router.push(`/person/${o.you.id}`)} accessibilityLabel="About you"
        outerStyle={{ borderRadius: 16 }} style={{ backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <PersonMark person={{ kind: 'person', name: o.you.name }} size={44} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="headline" numberOfLines={1}>{o.you.name}</Text>
            <Text variant="caption" color="ink3" numberOfLines={1}>{o.you.aliases.length ? `Also ${o.you.aliases.join(', ')}` : 'You'}</Text>
          </View>
        </View>
        {o.you.profile ? <Text variant="body" color="ink2">{o.you.profile}</Text> : null}
        {o.preferences.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text variant="label" color="ink2">How you like things</Text>
            {o.preferences.slice(0, 6).map((f) => (
              <View key={f.id} style={{ flexDirection: 'row', gap: 8 }}>
                <Text variant="body" color="ink3">{'\u2022'}</Text>
                <Text variant="body" style={{ flex: 1 }}>{f.text}</Text>
              </View>
            ))}
          </View>
        )}
      </Press>

      {o.open.length > 0 && (
        <FactGroup title="Open" facts={o.open} onOpen={open}
          meta={(f) => [f.about, f.due ? `due ${shortDate(f.due)}` : null].filter(Boolean).join(' · ')} />
      )}

      <FactGroup title="Recently learned" facts={o.recent} onOpen={open}
        meta={(f) => [f.about, heardFrom(f.origin, o.you.name), ago(f.learned_at)].filter(Boolean).join(' · ')} />

      {o.people.length > 0 && (
        <View style={{ gap: 8 }}>
          <SectionHeader title="People and things" action={o.people.length > 8 ? <Button label="See all" variant="ghost" size="sm" onPress={onPeople} /> : undefined} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {o.people.slice(0, 8).map((p) => (
              <Chip key={p.id} label={p.name} onPress={() => router.push(`/person/${p.id}`)} />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  )
}

function FactGroup({ title, facts, meta, onOpen }: {
  title: string; facts: OverviewFact[]; meta: (f: OverviewFact) => string; onOpen: (f: OverviewFact) => void
}) {
  const { c } = useTheme()
  if (!facts.length) return null
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={title} />
      <Squircle style={{ backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 4 }}>
        {facts.map((f, i) => (
          <View key={f.id}>
            {i > 0 && <View style={{ height: 1, backgroundColor: c.line, marginHorizontal: 12 }} />}
            <Press radius={12} static onPress={() => onOpen(f)} accessibilityLabel={f.text} accessibilityHint={`Opens ${f.about}`}
              style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
              <Text variant="body">{f.text}</Text>
              <Text variant="footnote" color={f.trust === 0 ? 'warning' : 'ink3'} numberOfLines={1}>{meta(f)}</Text>
            </Press>
          </View>
        ))}
      </Squircle>
    </View>
  )
}

/** Each teammate's how-to lessons, and notes from before memory v2. Tap for edit / forget. */
function Lessons({ bottom }: { bottom: number }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<MemoryItem | null>(null)

  const load = useCallback(() => api<MemoryItem[]>('/memories/all').then(setItems, (e: Error) => {
    setItems((l) => l ?? [])
    toast({ title: 'Unable to load lessons', body: e.message, tone: 'error' })
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
    try {
      await api(`/memories?scope=${m.scope}&id=${m.scope_id}&key=${encodeURIComponent(m.key)}`, { method: 'DELETE' })
      toast({ title: 'Forgotten', body: m.text })
    } catch (e) {
      toast({ title: 'Unable to delete that', body: (e as Error).message, tone: 'error' })
      load()
    }
  }
  const actions = { onToggle: (m: MemoryItem) => { haptic.tap(); patch(m, { done: !m.done }) }, onEdit: setEditing, onDelete: remove }
  // lessons first (they're the live part), then older notes
  const q = query.trim().toLowerCase()
  const shown = (items ?? [])
    .filter((m) => !q || m.text.toLowerCase().includes(q))
    .sort((a, b) => Number(b.kind === 'lesson') - Number(a.kind === 'lesson'))

  if (items === null) {
    return <View style={{ padding: 16, gap: 12 }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} radius={16} />)}</View>
  }
  if (items.length === 0) {
    return <EmptyState title="No lessons yet" body="When a teammate figures out how to do something for you, the how-to lands here so next time goes faster." />
  }
  return (
    <>
      <FlatList
        data={shown}
        keyExtractor={(m) => m.key}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottom }}
        ListHeaderComponent={<View style={{ paddingVertical: 12 }}><SearchField value={query} onChangeText={setQuery} placeholder="Search lessons" /></View>}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        renderItem={({ item }) => <MemoryCard m={item} {...actions} />}
        ListEmptyComponent={<Text variant="caption" color="ink3" style={{ padding: 8 }}>Nothing matches.</Text>}
      />
      <EditDialog item={editing} onClose={() => setEditing(null)} onSave={(m, text) => patch(m, { text })} />
    </>
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

