import { router } from 'expo-router'
import { useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { Add01Icon } from '@hugeicons/core-free-icons'
import type { ReactElement } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { useTabBarInset } from '@/components/tab-bar'
import { freeHandle, fromTemplate, modelName, roleName, toolkitName, useModels, useTemplates, type Template } from '@/lib/catalog'
import { supabase } from '@/lib/supabase'
import type { Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { motion, radius, useTheme } from '@/theme'
import { Button, Card, Chip, EmptyState, Skeleton, Squircle, TeammateAvatar, Text, haptic, toast } from '@/ui'

const openProfile = (id: string) => router.push({ pathname: '/teammate/[id]', params: { id } })

/** The Crew page of Chats: every teammate as a card, filtered by the shared search. */
export function CrewList({ header, query }: { header?: ReactElement; query: string }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const { models } = useModels()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => { setRefreshing(true); await ws.refresh(); setRefreshing(false) }
  const q = query.trim().toLowerCase()
  const crew = q ? ws.teammates.filter((t) => `${t.name} ${t.handle} ${t.role} ${t.bio}`.toLowerCase().includes(q)) : ws.teammates
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />

  if (ws.loading) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <View style={{ paddingHorizontal: 16, gap: 12 }} accessible accessibilityLabel="Loading your crew">
          {[0, 1, 2].map((i) => (
            <Squircle key={i} style={{ borderRadius: radius.xl, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, padding: 16, flexDirection: 'row', gap: 14 }}>
              <Skeleton width={64} height={64} radius={32} />
              <View style={{ flex: 1, gap: 8, paddingTop: 4 }}>
                <Skeleton width="40%" height={14} />
                <Skeleton width="70%" height={10} />
                <Skeleton width="55%" height={10} />
              </View>
            </Squircle>
          ))}
        </View>
      </View>
    )
  }

  return (
    <FlatList
      data={crew}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={header}
      ListEmptyComponent={ws.teammates.length === 0 ? <StarterTemplates /> : <EmptyState title="No one matches" body={`Nobody in your crew matches "${query.trim()}".`} />}
      contentContainerStyle={{ paddingBottom: inset + 96, gap: 12 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={refreshControl}
      renderItem={({ item, index }) => (
        <Animated.View entering={index < 8 ? FadeIn.duration(motion.duration.slow).delay(motion.staggerDelay(index)) : undefined} style={{ paddingHorizontal: 16 }}>
          <TeammateCard t={item} model={modelName(item.model, models)} working={ws.isWorking(item.id)} />
        </Animated.View>
      )}
    />
  )
}

function TeammateCard({ t, model, working }: { t: Teammate; model: string; working: boolean }) {
  const shown = t.allowed_toolkits.slice(0, 3)
  const more = t.allowed_toolkits.length - shown.length
  return (
    <Card
      radius={radius.xl}
      onPress={() => openProfile(t.id)}
      accessibilityLabel={`${t.name}, @${t.handle}, ${t.role}${working ? ', working' : ''}. ${t.bio}`}
      accessibilityHint="Opens their profile"
      style={{ padding: 16, flexDirection: 'row', gap: 14 }}
    >
      {/* Its own tap target: a tap on the face makes it hop instead of opening the profile. */}
      <TeammateAvatar teammate={t} size={64} state={working ? 'working' : 'default'} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>{t.name}</Text>
          <Text variant="caption" color="ink3" numberOfLines={1} style={{ flexShrink: 2 }}>@{t.handle}</Text>
          {working && <Chip label="Working" color="info" dot size="sm" />}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text variant="label" color="ink2" numberOfLines={1} style={{ flexShrink: 1 }}>{t.role}</Text>
          <View style={{ flex: 1 }} />
          <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flexShrink: 0, maxWidth: '50%' }}>{model}</Text>
        </View>
        {!!t.bio && <Text variant="caption" color="ink3" numberOfLines={1}>{t.bio}</Text>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
          {shown.map((tk) => <ToolChip key={tk} toolkit={tk} />)}
          {more > 0 && <Text variant="footnote" color="ink3" tabular>+{more}</Text>}
        </View>
      </View>
    </Card>
  )
}

function ToolChip({ toolkit }: { toolkit: string }) {
  const { c } = useTheme()
  return (
    <Squircle
      accessibilityLabel={toolkitName(toolkit)}
      style={{ height: 24, paddingHorizontal: 7, borderRadius: radius.sm, backgroundColor: c.panel2, flexDirection: 'row', alignItems: 'center', gap: 5 }}
    >
      <BrandMark toolkit={toolkit} size={12} color={c.ink2} />
      <Text variant="footnote" color="ink2">{toolkitName(toolkit)}</Text>
    </Squircle>
  )
}

/** Empty roster: what a teammate is, plus the four starter roles as one-tap cards. */
function StarterTemplates() {
  const ws = useWorkspace()
  const templates = useTemplates()
  const [adding, setAdding] = useState<string | null>(null)

  const add = async (t: Template) => {
    setAdding(t.role)
    const { error } = await supabase.from('teammates').insert({ ...fromTemplate(t), handle: freeHandle(t.handle, ws.teammates) })
    if (error) { setAdding(null); toast({ title: `Unable to add ${t.name}`, body: 'Check your connection and try again.', tone: 'error' }); return }
    haptic.success()
    await ws.refresh()
    setAdding(null)
    toast({ title: `${t.name} joined your team`, tone: 'success' })
  }

  return (
    <View>
      <EmptyState
        title={ws.error ? 'Unable to load your team' : 'No teammates yet'}
        body={ws.error ?? 'A teammate is an AI with a role, a memory and the apps you allow. Start with one of these, or build your own.'}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16, marginTop: -24 }}>
        {templates.map((t) => (
          <Card
            key={t.role}
            radius={radius.xl}
            onPress={() => add(t)}
            disabled={!!adding}
            accessibilityLabel={`Add ${t.name}, ${roleName(t.role)}`}
            accessibilityHint={t.bio}
            outerStyle={{ flexBasis: '46%', flexGrow: 1 }}
            style={{ padding: 16, gap: 10, opacity: adding && adding !== t.role ? 0.5 : 1 }}
          >
            <TeammateAvatar teammate={t} size={48} interactive={false} state={adding === t.role ? 'working' : 'default'} />
            <View style={{ gap: 2 }}>
              <Text variant="headline">{t.name}</Text>
              <Text variant="label" color="ink2" numberOfLines={1}>{roleName(t.role)}</Text>
              <Text variant="caption" color="ink3" numberOfLines={3}>{t.bio}</Text>
            </View>
            <Text variant="label" color="tube">{adding === t.role ? 'Adding…' : `Add ${t.name}`}</Text>
          </Card>
        ))}
      </View>
      <View style={{ alignItems: 'center', marginTop: 20 }}>
        <Button label="Build your own" variant="soft" icon={Add01Icon} onPress={() => router.push('/teammate/new')} />
      </View>
    </View>
  )
}
