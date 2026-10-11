// People and things the teammates know about (memory v2): the list on the Memory screen and the shared mark.
// People get their initials, everything else its kind's icon: real people never get a made-up face.
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { FlatList, View } from 'react-native'
import { Building03Icon, CubeIcon, Folder01Icon, Location01Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { ago } from '@/lib/format'
import type { Person } from '@/lib/types'
import { useTheme } from '@/theme'
import { EmptyState, Icon, ListRow, SearchField, Skeleton, Text, toast } from '@/ui'

const KIND_ICON = { org: Building03Icon, project: Folder01Icon, place: Location01Icon, thing: CubeIcon }
export const KIND_LABEL: Record<Person['kind'], string> = {
  person: 'Person', org: 'Organisation', project: 'Project', place: 'Place', thing: 'Thing',
}

export function PersonMark({ person, size = 40 }: { person: Pick<Person, 'kind' | 'name'>; size?: number }) {
  const { c } = useTheme()
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
      {person.kind === 'person'
        ? <Text variant={size > 48 ? 'heading' : 'label'} color="ink2" style={{ fontWeight: '600' }}>{initials}</Text>
        : <Icon icon={KIND_ICON[person.kind]} size={size * 0.45} color="ink2" />}
    </View>
  )
}

export function PeopleList({ bottom }: { bottom: number }) {
  const [people, setPeople] = useState<Person[] | null>(null)
  const [query, setQuery] = useState('')
  const load = useCallback(() => api<Person[]>('/people').then(setPeople, (e: Error) => {
    setPeople((l) => l ?? [])
    toast({ title: 'Unable to load people', body: e.message, tone: 'error' })
  }), [])
  useEffect(() => { load() }, [load])

  const q = query.trim().toLowerCase()
  const shown = (people ?? []).filter((p) => !q || [p.name, ...p.aliases, p.profile].some((s) => s.toLowerCase().includes(q)))

  if (people === null) {
    return (
      <View style={{ padding: 16, gap: 8 }}>
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={56} radius={12} />)}
      </View>
    )
  }
  if (people.length === 0) {
    return <EmptyState title="No one yet" body="As you chat, the people, companies and projects you mention show up here with what's true about them." />
  }
  return (
    <FlatList
      data={shown}
      keyExtractor={(p) => p.id}
      keyboardShouldPersistTaps="handled"
      onRefresh={load}
      refreshing={false}
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottom }}
      ListHeaderComponent={<View style={{ paddingVertical: 12 }}><SearchField value={query} onChangeText={setQuery} placeholder="Search people and things" /></View>}
      renderItem={({ item: p }) => (
        <ListRow
          leading={<PersonMark person={p} />}
          title={p.name}
          subtitle={p.profile || [KIND_LABEL[p.kind], `${p.facts} ${p.facts === 1 ? 'fact' : 'facts'}`, ago(p.touched_at)].join(' · ')}
          chevron
          onPress={() => router.push(`/person/${p.id}`)}
        />
      )}
      ListEmptyComponent={<Text variant="caption" color="ink3" style={{ padding: 8 }}>Nothing matches.</Text>}
    />
  )
}
