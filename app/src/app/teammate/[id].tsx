import { Redirect, router, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, ArrowDown01Icon, ArrowUp01Icon, BubbleChatIcon, Delete02Icon, Layers01Icon, MoreHorizontalIcon, PencilEdit02Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react-native'

import { ActivityRow } from '@/components/activity-row'
import { KnowledgeSection, SectionHead } from '@/components/knowledge'
import { AutomationRows } from '@/components/automation-rows'
import { MemoryList } from '@/components/memory-list'
import { ScreenHeader } from '@/components/screen-header'
import { ThreadAvatar } from '@/components/thread-avatar'
import {
  TeammateFields, draftOf, handleTakenError, sameDraft, validateTeammate, type DraftErrors, type TeammateDraft,
} from '@/components/teammate-form'
import { SAVE_BAR_SPACE, SaveBar } from '@/components/save-bar'
import { openSheet } from '@/components/sheet-screen'
import { isShown } from '@/lib/activity'
import { useAutomations } from '@/lib/automations'
import { modelName, useModels } from '@/lib/catalog'
import { supabase } from '@/lib/supabase'
import type { Activity, Teammate } from '@/lib/types'
import { computerId, isComputer, isExtraChat, useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import {
  Button, Divider, EmptyState, Icon, IconButton, ListRow, Press, Skeleton, Surface, TeammateAvatar, Text, TextSwap,
  confirm, haptic, showMenu, toast,
} from '@/ui'

const openThread = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })

export default function TeammateProfile() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const ws = useWorkspace()
  const t = ws.teammate(id)

  // A linked computer's chat is a teammate only under the hood: its page is the computer's.
  if (t && isComputer(t)) return <Redirect href={{ pathname: '/computers', params: { open: computerId(t)! } }} />
  if (!t) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas }}>
        <ScreenHeader />
        {ws.loading ? (
          <View style={{ alignItems: 'center', gap: 12, paddingTop: 32 }} accessible accessibilityLabel="Loading">
            <Skeleton width={88} height={88} radius={44} />
            <Skeleton width={120} height={18} />
            <Skeleton width={180} height={12} />
          </View>
        ) : (
          <EmptyState
            title="This teammate isn’t here anymore"
            body="They may have been deleted on another device."
            action={<Button label="Back to your team" variant="soft" onPress={() => router.replace('/')} />}
          />
        )}
      </View>
    )
  }

  return <Profile key={t.id} t={t} />
}

function Profile({ t }: { t: Teammate }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const { models } = useModels()
  const base = draftOf(t)
  const [edit, setEdit] = useState<TeammateDraft | null>(null)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const scroll = useRef<KeyboardAwareScrollViewRef>(null)
  const draft = edit ?? base
  const dirty = !!edit && !sameDraft(edit, base)
  const working = ws.isWorking(t.id)
  const chats = ws.chatsWith(t.id)

  const save = async () => {
    const e = validateTeammate(draft, ws.everyone, t.id)
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const { error } = await supabase.from('teammates')
      .update({ ...draft, name: draft.name.trim(), role: draft.role.trim(), bio: draft.bio.trim(), updated_at: new Date().toISOString() })
      .eq('id', t.id)
    if (error) {
      setSaving(false)
      const taken = handleTakenError(error, draft.handle)
      if (taken) setErrors(taken)
      else toast({ title: 'Unable to save changes', body: 'Check your connection and try again.', tone: 'error' })
      return
    }
    await ws.refresh()
    setSaving(false)
    setEdit(null)
    haptic.success()
    toast({ title: 'Changes saved', tone: 'success' })
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${t.name}?`,
      body: `This also deletes your chats with ${t.name} and their automations, and removes them from every project. It can’t be undone.`,
      confirmLabel: 'Delete teammate',
      destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('teammates').delete().eq('id', t.id)
    if (error) { toast({ title: `Unable to delete ${t.name}`, body: 'Check your connection and try again.', tone: 'error' }); return }
    router.back()
    await ws.refresh()
    toast({ title: `${t.name} was deleted` })
  }
  const newChat = async () => {
    try {
      const empty = chats.find((x) => isExtraChat(x.id) && !x.last_message_at)
      openThread(empty?.id ?? await ws.newChat(t.id))
    } catch (e) { toast({ title: 'Unable to start a chat', body: (e as Error).message, tone: 'error' }) }
  }
  const openEdit = () => { setEditing(true); setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 300) }
  const latest = chats[0]?.id ?? `dm:${t.id}`
  const tint = t.color || c.tube

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      {/* Over the content: clear on the colour wash, solid with the name once the hero has scrolled away. */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 }}>
      <ScreenHeader
        transparent={!scrolled}
        title={scrolled ? t.name : undefined}
        right={
          <IconButton
            icon={MoreHorizontalIcon}
            accessibilityLabel="More"
            onPress={() => showMenu({
              title: t.name,
              items: [
                { label: 'Edit profile', icon: PencilEdit02Icon, onPress: openEdit },
                { label: 'Delete teammate', icon: Delete02Icon, destructive: true, onPress: remove },
              ],
            })}
          />
        }
      />
      </View>
      <KeyboardAwareScrollView ref={scroll} scrollEventThrottle={32}
        onScroll={(e) => { const y = e.nativeEvent.contentOffset.y > 180; if (y !== scrolled) setScrolled(y) }} bottomOffset={dirty ? SAVE_BAR_SPACE : 96} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + (dirty ? SAVE_BAR_SPACE : 48) }}>
        {/* Their colour, washed in behind the face and gone by the actions; it scrolls away with them. */}
        <LinearGradient pointerEvents="none" colors={[`${tint}5c`, `${tint}1f`, `${tint}00`]} locations={[0, 0.5, 1]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + 440 }} />
        <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: insets.top + 64, gap: 14 }}>
          <TeammateAvatar teammate={draft} size={112} live state={working ? 'working' : 'default'} />
          <View style={{ alignItems: 'center', gap: 4 }}>
            <Text variant="title" numberOfLines={1}>{t.name}</Text>
            <Text variant="caption" color="ink2" numberOfLines={1}>{t.role}<Text variant="caption" color="ink3">{'  ·  '}@{t.handle}</Text></Text>
          </View>
          {/* Tubelight's mark for a teammate: a short tube in their colour, lit while they work. */}
          <View style={{ alignItems: 'center', gap: 8 }}>
            <View style={{ width: 28, height: 3, borderRadius: 2, backgroundColor: tint, opacity: working ? 1 : 0.55,
              shadowColor: tint, shadowOpacity: working ? 0.9 : 0.4, shadowRadius: working ? 8 : 4, shadowOffset: { width: 0, height: 0 }, elevation: working ? 6 : 0 }} />
            <TextSwap variant="footnote" color={working ? 'ink2' : 'ink3'}>{working ? 'Working on something now' : `Thinks with ${modelName(t.model, models)}`}</TextSwap>
          </View>
          {!!t.bio && <Text variant="body" color="ink2" align="center" style={{ maxWidth: 340 }}>{t.bio}</Text>}
        </View>

        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 24 }}>
          <Tile icon={BubbleChatIcon} label="Message" onPress={() => openThread(latest)} primary />
          <Tile icon={Layers01Icon} label={chats.length > 1 ? `${chats.length} chats` : 'New chat'} onPress={chats.length > 1 ? () => router.push({ pathname: '/chat/[threadId]', params: { threadId: latest, chats: '1' } }) : newChat} />
          <Tile icon={Add01Icon} label="New chat" onPress={newChat} hidden={chats.length <= 1} />
        </View>

        <View style={{ paddingHorizontal: 20, paddingTop: 40, gap: 40 }}>
          <KnowledgeSection t={t} />
          <Overview t={t} />
          <View style={{ gap: 12 }}>
            <SectionHead title="Profile" hint={`How ${t.name} introduces itself and works.`} />
            <Surface style={{ overflow: 'hidden' }}>
              <ListRow title={editing ? 'Hide the profile' : 'Edit name, role and instructions'} icon={PencilEdit02Icon}
                onPress={() => { haptic.tap(); setEditing((e) => !e) }} accessory={<Icon icon={editing ? ArrowUp01Icon : ArrowDown01Icon} size={16} color="ink3" />} />
              <Divider inset={52} />
              <ListRow title="Delete teammate" icon={Delete02Icon} destructive onPress={remove} />
            </Surface>
            {editing && (
              <Animated.View entering={FadeIn.duration(motion.duration.fast)} style={{ paddingTop: 12 }}>
                <TeammateFields value={draft} onChange={setEdit} errors={errors} />
              </Animated.View>
            )}
          </View>
        </View>
      </KeyboardAwareScrollView>

      {dirty && (
        <SaveBar
          body={`Save to update ${t.name}, or discard to keep things as they were.`}
          saving={saving}
          onDiscard={() => { setEdit(null); setErrors({}) }}
          onSave={save}
        />
      )}
    </View>
  )
}

/** One of the profile's three actions: a squircle tile, the first one solid. */
function Tile({ icon, label, onPress, primary, hidden }: { icon: IconSvgElement; label: string; onPress: () => void; primary?: boolean; hidden?: boolean }) {
  const { c } = useTheme()
  if (hidden) return null
  return (
    <Press radius={18} onPress={onPress} accessibilityLabel={label} outerStyle={{ flex: 1 }}
      style={{ height: 68, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: primary ? c.ink : c.panel, borderWidth: primary ? 0 : 1, borderColor: c.line }}>
      <Icon icon={icon} size={20} color={primary ? 'canvas' : 'ink'} />
      <Text variant="label" color={primary ? 'canvas' : 'ink'}>{label}</Text>
    </Press>
  )
}

function Overview({ t }: { t: Teammate }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const [recent, setRecent] = useState<Activity[] | null>(null)
  const projects = ws.projects.filter((p) => ws.members.some((m) => m.project_id === p.id && m.teammate_id === t.id))
  const autos = useAutomations()
  const mine = autos.list?.filter((a) => a.teammate_id === t.id) ?? null

  useEffect(() => {
    supabase.from('activity').select('*').eq('teammate_id', t.id).not('type', 'in', '(run_start,run_end)')
      .order('created_at', { ascending: false }).limit(12)
      .then(({ data }) => setRecent(((data ?? []) as Activity[]).filter(isShown).slice(0, 5)))
  }, [t.id])

  return (
    <View style={{ gap: 40 }}>
      <Section title="Remembers" hint={`Facts ${t.name} keeps between conversations.`}>
        <MemoryList scope="teammate" id={t.id} owner={t.name} />
      </Section>

      <Section
        title="On its own"
        hint={mine?.length ? `What ${t.name} does without being asked.` : undefined}
        action={<Button label="New" size="sm" variant="soft" icon={Add01Icon} onPress={() => router.push({ pathname: '/automation/[id]', params: { id: 'new', teammate: t.id } })} />}
      >
        {mine === null ? (
          <Surface padding={16} style={{ gap: 10 }}><Skeleton width="70%" /><Skeleton width="45%" /></Surface>
        ) : mine.length === 0 ? (
          <Text variant="caption" color="ink3">Nothing yet. Ask {t.name} in chat, like “every morning at 8, brief me on what’s new”.</Text>
        ) : (
          <AutomationRows items={mine} show="where" onToggle={autos.toggle} />
        )}
      </Section>

      <Section title="Works in" hint={projects.length ? undefined : 'Projects are group chats where teammates work together.'}
        action={projects.length ? undefined : <Button label="New project" size="sm" variant="soft" icon={Add01Icon} onPress={() => openSheet('project')} />}>
        {projects.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {projects.map((p) => (
              <Press key={p.id} radius={22} onPress={() => openThread(`proj:${p.id}`)} accessibilityLabel={`${p.name}, ${ws.membersOf(p.id).length} members`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4, paddingRight: 14, height: 44, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line }}>
                <ThreadAvatar threadId={`proj:${p.id}`} size={34} />
                <Text variant="label">{p.name}</Text>
                <Text variant="footnote" color="ink3" tabular>{ws.membersOf(p.id).length}</Text>
              </Press>
            ))}
          </View>
        )}
      </Section>

      <Section
        title="Lately"
        action={recent && recent.length > 0 ? (
          <Button label="See all" size="sm" variant="ghost" onPress={() => router.push({ pathname: '/activity', params: { teammate: t.id } })} />
        ) : undefined}
      >
        {recent === null ? (
          <Surface padding={16} style={{ gap: 10 }}><Skeleton width="75%" /><Skeleton width="50%" /></Surface>
        ) : recent.length === 0 ? (
          <Text variant="caption" color="ink3">Nothing yet. When {t.name} uses a tool or asks for your approval, it shows up here.</Text>
        ) : (
          <Surface style={{ overflow: 'hidden', paddingVertical: 4 }}>
            {recent.map((a) => <ActivityRow key={a.id} a={a} />)}
          </Surface>
        )}
      </Section>
    </View>
  )
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <SectionHead title={title} hint={hint} action={action} />
      {children}
    </View>
  )
}
