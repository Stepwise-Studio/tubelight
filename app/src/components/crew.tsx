import { router } from 'expo-router'
import { useState } from 'react'
import { Image } from 'expo-image'
import { FlatList, RefreshControl, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { Add01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { ReactElement } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { useTabBarInset } from '@/components/tab-bar'
import { openSheet } from '@/components/sheet-screen'
import { freeHandle, fromTemplate, roleName, toolkitName, useConnections, useTemplates, type Template } from '@/lib/catalog'
import { supabase } from '@/lib/supabase'
import type { Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { motion, radius, useTheme } from '@/theme'
import { Button, Card, Chip, EmptyState, Icon, Press, Skeleton, Squircle, TeammateAvatar, Text, haptic, toast } from '@/ui'

const openProfile = (id: string) => router.push({ pathname: '/teammate/[id]', params: { id } })

const GAP = 12
const BAND = 72 // the colour wash at the top of a card
const FACE = 56

/** The Crew page of Chats: every teammate as a profile card in a two-column grid, filtered by the shared search. */
export function CrewList({ header, query }: { header?: ReactElement; query: string }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const inset = useTabBarInset()
  const { width } = useWindowDimensions()
  const { connections } = useConnections()
  const logos = Object.fromEntries((connections ?? []).map((k) => [k.toolkit, k.logo]))
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => { setRefreshing(true); await ws.refresh(); setRefreshing(false) }
  const q = query.trim().toLowerCase()
  const crew = q ? ws.teammates.filter((t) => `${t.name} ${t.handle} ${t.role} ${t.bio}`.toLowerCase().includes(q)) : ws.teammates
  const cell = (width - 32 - GAP) / 2
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />

  if (ws.loading) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <View style={{ paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', gap: GAP }} accessible accessibilityLabel="Loading your crew">
          {[0, 1, 2, 3].map((i) => (
            <Squircle key={i} style={{ width: cell, borderRadius: radius.xl, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
              <View style={{ height: BAND, backgroundColor: c.panel2 }} />
              <View style={{ padding: 14, paddingTop: FACE / 2 + 10, gap: 8 }}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="45%" height={10} />
                <Skeleton width="90%" height={10} />
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
      numColumns={2}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={header}
      ListFooterComponent={q || !crew.length ? null : <NewTeammateCard />}
      ListEmptyComponent={ws.teammates.length === 0 ? <StarterTemplates /> : <EmptyState title="No one matches" body={`Nobody in your crew matches "${query.trim()}".`} />}
      contentContainerStyle={{ paddingBottom: inset + 96, gap: GAP }}
      columnWrapperStyle={{ gap: GAP, paddingHorizontal: 16 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={refreshControl}
      renderItem={({ item, index }) => (
        <Animated.View entering={index < 8 ? FadeIn.duration(motion.duration.slow).delay(motion.staggerDelay(index)) : undefined} style={{ width: cell }}>
          <TeammateCard t={item} logos={logos} working={ws.isWorking(item.id)} />
        </Animated.View>
      )}
    />
  )
}

/**
 * A profile card: the teammate's colour washes the top, their face sits on its edge, then name, role and a
 * two-line bio; the footer shows the apps they can use and a shortcut straight into their chat.
 */
function TeammateCard({ t, logos, working }: { t: Teammate; logos: Record<string, string | undefined>; working: boolean }) {
  const { c, scheme } = useTheme()
  const apps = t.allowed_toolkits
  const shown = apps.slice(0, 3)
  const more = apps.length - shown.length
  return (
    <Card
      radius={radius.xl}
      onPress={() => openProfile(t.id)}
      accessibilityLabel={`${t.name}, ${t.role}${working ? ', working' : ''}. ${t.bio}`}
      accessibilityHint="Opens their profile"
      outerStyle={{ flex: 1 }}
      style={{ flex: 1, overflow: 'hidden' }}
    >
      <View style={{
        height: BAND,
        // Fades all the way into the card: no edge where the colour stops.
        experimental_backgroundImage: `linear-gradient(to bottom, ${t.color}${scheme === 'dark' ? '73' : '8C'} 0%, ${t.color}${scheme === 'dark' ? '2E' : '38'} 55%, ${t.color}00 100%)`,
        alignItems: 'flex-end', padding: 8,
      }}>
        {working && <Chip label="Working" color="info" dot size="sm" />}
      </View>
      {/* The face overlaps the band's edge, ringed in the card colour. */}
      <View style={{ position: 'absolute', top: BAND - FACE + 4, left: 12, borderRadius: FACE, borderWidth: 3, borderColor: c.panel }}>
        <TeammateAvatar teammate={t} size={FACE} interactive={false} state={working ? 'working' : 'default'} />
      </View>
      <View style={{ flex: 1, paddingHorizontal: 14, paddingTop: 16, paddingBottom: 12 }}>
        <Text variant="headline" numberOfLines={1}>{t.name}</Text>
        <Text variant="footnote" color="ink2" numberOfLines={1}>{t.role}</Text>
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }} accessibilityLabel={apps.length ? `Apps: ${apps.map(toolkitName).join(', ')}` : 'No apps'}>
            {shown.map((tk, i) => <AppDot key={tk} toolkit={tk} logo={logos[tk]} style={{ marginLeft: i ? -7 : 0, zIndex: shown.length - i }} />)}
            {more > 0 && <Text variant="footnote" color="ink3" tabular style={{ marginLeft: 6 }}>+{more}</Text>}
            {!apps.length && <Text variant="footnote" color="ink4">No apps yet</Text>}
          </View>
        </View>
      </View>
    </Card>
  )
}

/** One app, as a small round logo tile (stacked, they overlap like an avatar group). */
function AppDot({ toolkit, logo, style }: { toolkit: string; logo?: string; style?: object }) {
  const { c } = useTheme()
  return (
    <View style={[{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff', borderWidth: 2, borderColor: c.panel, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}>
      {logo ? <Image source={{ uri: logo }} style={{ width: 14, height: 14 }} contentFit="contain" /> : <BrandMark toolkit={toolkit} size={12} color="#18181b" />}
    </View>
  )
}

/** Under the grid, full width: a friendly way to bring someone new onto the team. */
function NewTeammateCard() {
  const { c } = useTheme()
  return (
    <Press
      radius={radius.xl}
      onPress={() => { haptic.tap(); openSheet('teammate') }}
      accessibilityRole="button"
      accessibilityLabel="Add a teammate"
      accessibilityHint="Start from a ready-made role or build your own"
      outerStyle={{ marginHorizontal: 16, marginTop: 4 }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.line }}
    >
      <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.tubeSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon icon={Add01Icon} size={22} color={c.tube} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="headline">Add a teammate</Text>
        <Text variant="footnote" color="ink3">Start from a role like Dev or Sol, or build your own.</Text>
      </View>
      <Icon icon={ArrowRight01Icon} size={18} color="ink3" />
    </Press>
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
        <Button label="Build your own" variant="soft" icon={Add01Icon} onPress={() => openSheet('teammate')} />
      </View>
    </View>
  )
}
