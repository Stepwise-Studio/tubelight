import { Redirect, router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { BackHandler, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, BubbleChatIcon, Delete02Icon, PencilEdit02Icon } from '@hugeicons/core-free-icons'

import { KnowledgeFiles, SectionHead, SubHead } from '@/components/knowledge'
import { AutomationRows } from '@/components/automation-rows'
import { MemoryList } from '@/components/memory-list'
import { ScreenHeader } from '@/components/screen-header'
import { ThreadAvatar } from '@/components/thread-avatar'
import {
  ModelPill, TeammateFields, ToolkitPicker, draftOf, handleTakenError, sameDraft, validateTeammate, type DraftErrors, type TeammateDraft,
} from '@/components/teammate-form'
import { SAVE_BAR_SPACE, SaveBar } from '@/components/save-bar'
import { openSheet } from '@/components/sheet-screen'
import { useAutomations } from '@/lib/automations'
import { supabase } from '@/lib/supabase'
import type { Teammate } from '@/lib/types'
import { computerId, isComputer, useWorkspace } from '@/lib/workspace'
import { motion, useTheme } from '@/theme'
import {
  Button, EmptyState, IconButton, Press, Skeleton, Surface, TeammateAvatar, Text,
  confirm, haptic, toast,
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
  const base = draftOf(t)
  const [edit, setEdit] = useState<TeammateDraft | null>(null)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const draft = edit ?? base
  const dirty = !!edit && !sameDraft(edit, base)
  const working = ws.isWorking(t.id)
  const tint = t.color || c.tube

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
    setEditing(false)
    haptic.success()
    toast({ title: 'Changes saved', tone: 'success' })
  }
  /** Model and apps change straight from the page: saved at once. */
  const patch = async (fields: Partial<TeammateDraft>) => {
    const { error } = await supabase.from('teammates').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', t.id)
    if (error) toast({ title: 'Unable to save', body: 'Check your connection and try again.', tone: 'error' })
    else { haptic.success(); ws.refresh() }
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
  const stopEditing = () => { setEdit(null); setErrors({}); setEditing(false) }
  // Android's back closes the form first, then leaves the page.
  useEffect(() => {
    if (!editing) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setEdit(null); setErrors({}); setEditing(false); return true })
    return () => sub.remove()
  }, [editing])

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      {/* Over the content: clear on the colour wash, solid with the name once the hero has scrolled away. */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 }}>
        <ScreenHeader
          transparent={!scrolled && !editing}
          title={editing ? `Edit ${t.name}` : scrolled ? t.name : undefined}
          onBack={editing ? stopEditing : undefined}
          right={editing ? null : <IconButton icon={PencilEdit02Icon} accessibilityLabel={`Edit ${t.name}`} onPress={() => { haptic.tap(); setEditing(true) }} />}
        />
      </View>
      <KeyboardAwareScrollView key={editing ? 'edit' : 'view'} scrollEventThrottle={32}
        onScroll={(e) => { const y = e.nativeEvent.contentOffset.y > 180; if (y !== scrolled) setScrolled(y) }}
        bottomOffset={dirty ? SAVE_BAR_SPACE : 96} keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: editing ? insets.top + 72 : 0, paddingBottom: insets.bottom + (dirty ? SAVE_BAR_SPACE : 48) }}>
        {editing ? (
          <Animated.View entering={FadeIn.duration(motion.duration.fast)} style={{ paddingHorizontal: 20 }}>
            <TeammateFields value={draft} onChange={setEdit} errors={errors} />
          </Animated.View>
        ) : (
          <>
            {/* Their colour, washed in behind the face; it scrolls away with it. */}
            <LinearGradient pointerEvents="none" colors={[`${tint}5c`, `${tint}1f`, `${tint}00`]} locations={[0, 0.5, 1]}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top + 440 }} />
            <View style={{ alignItems: 'center', paddingHorizontal: 24, paddingTop: insets.top + 64, gap: 14 }}>
              <TeammateAvatar teammate={t} size={112} live state={working ? 'working' : 'default'} />
              <View style={{ alignItems: 'center', gap: 4 }}>
                <Text variant="title" numberOfLines={1}>{t.name}</Text>
                <Text variant="caption" color="ink2" numberOfLines={1}>{t.role}<Text variant="caption" color="ink3">{'  ·  '}@{t.handle}</Text></Text>
              </View>
              {/* Tubelight's mark for a teammate: a short tube in their colour, lit while they work. */}
              <View style={{ width: 28, height: 3, borderRadius: 2, backgroundColor: tint, opacity: working ? 1 : 0.55,
                shadowColor: tint, shadowOpacity: working ? 0.9 : 0.4, shadowRadius: working ? 8 : 4, shadowOffset: { width: 0, height: 0 }, elevation: working ? 6 : 0 }} />
              <ModelPill value={t.model} role={t.role} onChange={(model) => patch({ model })} />
              {!!t.bio && <Text variant="body" color="ink2" align="center" style={{ maxWidth: 340 }}>{t.bio}</Text>}
              <Button label={`Message ${t.name}`} icon={BubbleChatIcon} onPress={() => openThread(ws.chatsWith(t.id)[0]?.id ?? `dm:${t.id}`)} style={{ alignSelf: 'center', marginTop: 4 }} />
            </View>

            <View style={{ paddingHorizontal: 20, paddingTop: 40, gap: 40 }}>
              <Section title="Apps" hint="What they can use. Sending, posting and pushing always wait for your approval.">
                <ToolkitPicker value={t.allowed_toolkits} onChange={(allowed_toolkits) => patch({ allowed_toolkits })} />
              </Section>
              <Section title="Memory" hint={`What ${t.name} knows: files you hand over, and facts it keeps from your chats.`}>
                <KnowledgeFiles t={t} />
                <View style={{ gap: 8, paddingTop: 12 }}>
                  <SubHead title="Facts" />
                  <MemoryList scope="teammate" id={t.id} owner={t.name} />
                </View>
              </Section>
              <Overview t={t} />
              <Section title="Delete">
                <Text variant="caption" color="ink3">Deleting {t.name} also deletes your chats with them.</Text>
                <Button label="Delete teammate" variant="outline" icon={Delete02Icon} onPress={remove} style={{ alignSelf: 'flex-start' }} />
              </Section>
            </View>
          </>
        )}
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

function Overview({ t }: { t: Teammate }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const projects = ws.projects.filter((p) => ws.members.some((m) => m.project_id === p.id && m.teammate_id === t.id))
  const autos = useAutomations()
  const mine = autos.list?.filter((a) => a.teammate_id === t.id) ?? null


  return (
    <View style={{ gap: 40 }}>
      <Section
        title="Automations"
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

      <Section title="Projects" hint={projects.length ? undefined : 'Projects are group chats where teammates work together.'}
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
