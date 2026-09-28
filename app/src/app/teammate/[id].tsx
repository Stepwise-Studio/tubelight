import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, BubbleChatIcon, Delete02Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'

import { ActivityRow } from '@/components/activity-row'
import { AutomationRows } from '@/components/automation-rows'
import { FormSection } from '@/components/form-bits'
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
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import {
  Button, Divider, EmptyState, IconButton, ListRow, Segment, Skeleton, Surface, TeammateAvatar, Text,
  confirm, haptic, showMenu, toast,
} from '@/ui'

type Tab = 'overview' | 'settings'

const openThread = (threadId: string) => router.push({ pathname: '/chat/[threadId]', params: { threadId } })

export default function TeammateProfile() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const ws = useWorkspace()
  const t = ws.teammate(id)
  const [tab, setTab] = useState<Tab>('overview')

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

  return <Profile key={t.id} t={t} tab={tab} setTab={setTab} />
}

function Profile({ t, tab, setTab }: { t: Teammate; tab: Tab; setTab: (t: Tab) => void }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const { models } = useModels()
  const base = draftOf(t)
  const [edit, setEdit] = useState<TeammateDraft | null>(null)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)
  const draft = edit ?? base
  const dirty = !!edit && !sameDraft(edit, base)
  const working = ws.isWorking(t.id)

  const save = async () => {
    const e = validateTeammate(draft, ws.teammates, t.id)
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
      body: `This also deletes your direct messages with ${t.name} and their event rules, and removes them from every project. It can’t be undone.`,
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

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader
        title={t.name}
        right={
          <IconButton
            icon={MoreHorizontalIcon}
            accessibilityLabel="More"
            onPress={() => showMenu({
              title: t.name,
              items: [
                { label: 'Message', icon: BubbleChatIcon, onPress: () => openThread(`dm:${t.id}`) },
                { label: 'Delete teammate', icon: Delete02Icon, destructive: true, onPress: remove },
              ],
            })}
          />
        }
      />
      <KeyboardAwareScrollView bottomOffset={dirty ? SAVE_BAR_SPACE : 96} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + (dirty ? SAVE_BAR_SPACE : 40) }}>
        <View style={{ alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, gap: 12 }}>
          <TeammateAvatar teammate={draft} size={88} live state={working ? 'working' : 'default'} />
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Text variant="title" numberOfLines={1}>{t.name}</Text>
            <Text variant="caption" color="ink3" numberOfLines={1}>@{t.handle} · {t.role}</Text>
          </View>
          {!!t.bio && <Text variant="body" color="ink2" align="center" style={{ maxWidth: 340 }}>{t.bio}</Text>}
          <Text variant="footnote" color="ink3">{working ? 'Working now' : modelName(t.model, models)}</Text>
          <Button label={`Message ${t.name}`} icon={BubbleChatIcon} onPress={() => openThread(`dm:${t.id}`)} style={{ alignSelf: 'center', marginTop: 4 }} />
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 28, paddingBottom: 24 }}>
          <Segment<Tab>
            value={tab}
            onChange={setTab}
            accessibilityLabel="Profile sections"
            options={[{ value: 'overview', label: 'Overview' }, { value: 'settings', label: 'Settings' }]}
          />
        </View>

        <View style={{ paddingHorizontal: 20 }}>
          {tab === 'overview' ? <Overview t={t} /> : (
            <View style={{ gap: 40 }}>
              <TeammateFields value={draft} onChange={setEdit} errors={errors} />
              <FormSection title="Delete">
                <Text variant="caption" color="ink3">Deleting {t.name} also deletes your direct messages with them.</Text>
                <Button label="Delete teammate" variant="outline" icon={Delete02Icon} onPress={remove} />
              </FormSection>
            </View>
          )}
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

function Overview({ t }: { t: Teammate }) {
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
    <View style={{ gap: 32 }}>
      <FormSection title="Memory" hint={`Facts ${t.name} keeps between conversations.`}>
        <MemoryList scope="teammate" id={t.id} owner={t.name} />
      </FormSection>

      <FormSection
        title="Automations"
        hint={mine?.length ? `What ${t.name} does on their own.` : undefined}
        action={<Button label="New" size="sm" variant="soft" icon={Add01Icon} onPress={() => router.push({ pathname: '/automation/[id]', params: { id: 'new', teammate: t.id } })} />}
      >
        {mine === null ? (
          <Surface padding={16} style={{ gap: 10 }}><Skeleton width="70%" /><Skeleton width="45%" /></Surface>
        ) : mine.length === 0 ? (
          <Text variant="caption" color="ink3">None yet. Ask {t.name} in chat, like “every morning at 8, brief me on what’s new”.</Text>
        ) : (
          <AutomationRows items={mine} show="where" onToggle={autos.toggle} />
        )}
      </FormSection>

      <FormSection title="Projects">
        {projects.length === 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text variant="caption" color="ink3" style={{ flex: 1 }}>Not in any project yet. Projects are group chats where teammates work together.</Text>
            <Button label="New project" size="sm" variant="soft" icon={Add01Icon} onPress={() => openSheet('project')} />
          </View>
        ) : (
          <Surface style={{ overflow: 'hidden' }}>
            {projects.map((p, i) => (
              <View key={p.id}>
                {i > 0 && <Divider inset={64} />}
                <ListRow
                  title={p.name}
                  subtitle={`${ws.membersOf(p.id).length} members${p.description ? ` · ${p.description}` : ''}`}
                  leading={<ThreadAvatar threadId={`proj:${p.id}`} size={40} />}
                  chevron
                  onPress={() => openThread(`proj:${p.id}`)}
                />
              </View>
            ))}
          </Surface>
        )}
      </FormSection>

      <FormSection
        title="Recent activity"
        action={recent && recent.length > 0 ? (
          <Button label="See all" size="sm" variant="ghost" onPress={() => router.push({ pathname: '/activity', params: { teammate: t.id } })} />
        ) : undefined}
      >
        {recent === null ? (
          <Surface padding={16} style={{ gap: 10 }}><Skeleton width="75%" /><Skeleton width="50%" /></Surface>
        ) : recent.length === 0 ? (
          <Text variant="caption" color="ink3">Nothing yet. When {t.name} uses a tool, hands off or asks for approval, it shows up here.</Text>
        ) : (
          <Surface style={{ overflow: 'hidden', paddingVertical: 4 }}>
            {recent.map((a) => <ActivityRow key={a.id} a={a} />)}
          </Surface>
        )}
      </FormSection>
    </View>
  )
}
