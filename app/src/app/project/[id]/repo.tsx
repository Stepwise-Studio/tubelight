// What teammates know about a project's repo (agent-service repo.py): the brief they read (editable), notes they've
// added, each area of the code, and the commits it has caught up with.
import { useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PencilEdit02Icon, RefreshIcon } from '@hugeicons/core-free-icons'

import { FormSection } from '@/components/form-bits'
import { repoStatusLine, useRepoKnowledge } from '@/components/repo-picker'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import { ago } from '@/lib/format'
import { useTheme } from '@/theme'
import {
  Button, Collapse, Divider, EmptyState, IconButton, Markdown, Notice, Press, Skeleton, Surface, Text, TextField, haptic, toast,
} from '@/ui'

export default function RepoKnowledgeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const { k, reload, setK } = useRepoKnowledge(id)
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reindex = async () => {
    haptic.tap()
    try {
      await api(`/projects/${id}/repo/reindex`, { method: 'POST' })
      setK((x) => (x?.state ? { ...x, state: { ...x.state, status: 'checking', progress: 0 } } : x))
      reload()
    } catch (e) { toast({ title: 'Unable to re-read it', body: (e as Error).message, tone: 'error' }) }
  }
  const saveBrief = async (text: string | null) => {
    setSaving(true)
    try {
      const view = await api<Partial<NonNullable<typeof k>>>(`/projects/${id}/repo/brief`, { method: 'PATCH', json: { text } })
      setK((x) => (x ? { ...x, ...view } : x))
      setEditing(null)
      haptic.success()
      toast({ title: text ? 'Brief saved' : 'Back to the generated brief', tone: 'success' })
    } catch (e) { toast({ title: 'Unable to save the brief', body: (e as Error).message, tone: 'error' }) } finally { setSaving(false) }
  }

  const status = repoStatusLine(k?.state)
  const busy = k?.state?.status === 'reading' || k?.state?.status === 'checking'
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Repo knowledge" subtitle={k?.repo ?? undefined}
        right={k?.repo ? <IconButton icon={RefreshIcon} accessibilityLabel="Read the repo again" disabled={busy} onPress={reindex} /> : undefined} />
      {k === null ? (
        <View style={{ padding: 20, gap: 12 }}><Skeleton width="60%" /><Skeleton height={160} radius={16} /></View>
      ) : !k.repo ? (
        <EmptyState title="No repo yet" body="Pick one in the project's settings and teammates here will learn it." />
      ) : (
        <KeyboardAwareScrollView bottomOffset={96} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 40, gap: 28 }}>
          {k.state?.status === 'error'
            ? <Notice tone="error" title="Couldn’t read the repo" body={k.state.error ?? undefined} action={{ label: 'Retry', onPress: reindex }} />
            : <Text variant="footnote" color={status.tone} accessibilityLiveRegion="polite">{status.text}</Text>}

          <FormSection
            title="Brief"
            hint={k.edited ? 'Your version: teammates read this. New commits don’t change it.' : 'Every teammate here reads this before working on the code.'}
            action={editing === null && (k.brief || k.generated)
              ? <Button label="Edit" size="sm" variant="ghost" icon={PencilEdit02Icon} onPress={() => setEditing(k.mine || k.generated)} />
              : undefined}
          >
            {editing !== null ? (
              <View style={{ gap: 10 }}>
                <TextField value={editing} onChangeText={setEditing} multiline showCount maxLength={8000} inputStyle={{ minHeight: 240 }} />
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                  <Button label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
                  <Button label="Save brief" loading={saving} onPress={() => saveBrief(editing.trim() || null)} />
                </View>
              </View>
            ) : k.brief ? (
              <Surface padding={16} style={{ gap: 8 }}>
                <Markdown value={k.brief} />
                {k.edited && <Button label="Use the generated brief instead" size="sm" variant="ghost" style={{ alignSelf: 'flex-start' }} onPress={() => saveBrief(null)} />}
              </Surface>
            ) : (
              <Surface padding={16} style={{ gap: 10 }}>
                <Text variant="caption" color="ink3">{busy ? 'Writing it now…' : 'Not written yet.'}</Text>
                {busy && <><Skeleton width="80%" /><Skeleton width="65%" /><Skeleton width="70%" /></>}
              </Surface>
            )}
          </FormSection>

          {k.areas.length > 0 && (
            <FormSection title="Areas" hint="Each part of the code, read separately. Only the parts a commit touches are re-read.">
              <Surface style={{ overflow: 'hidden' }}>
                {k.areas.map((a, i) => (
                  <View key={a.name}>
                    {i > 0 && <Divider inset={16} />}
                    <Area name={a.name} files={a.files} summary={a.summary} />
                  </View>
                ))}
              </Surface>
            </FormSection>
          )}

          <FormSection title="Recent changes" hint={k.log.length ? 'Commits it has caught up with, newest first.' : undefined}>
            {k.log.length === 0 ? (
              <Text variant="caption" color="ink3">Nothing yet. New commits show up here after the next check (every 6 hours, after a teammate pushes, or when you tap refresh).</Text>
            ) : (
              <Surface style={{ overflow: 'hidden' }}>
                {k.log.map((e, i) => (
                  <View key={`${e.to}-${i}`} style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4, borderTopWidth: i ? 1 : 0, borderTopColor: c.line }}>
                    <Text variant="footnote" color="ink3">{ago(e.at)} · {e.from}..{e.to}</Text>
                    {e.commits.slice(0, 8).map((cm) => (
                      <Text key={cm.sha} variant="caption" color="ink2" numberOfLines={2}>{cm.message} <Text variant="caption" color="ink3">({cm.author})</Text></Text>
                    ))}
                  </View>
                ))}
              </Surface>
            )}
          </FormSection>
        </KeyboardAwareScrollView>
      )}
    </View>
  )
}

function Area({ name, files, summary }: { name: string; files: number; summary: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Press radius={0} static onPress={() => setOpen((o) => !o)} accessibilityState={{ expanded: open }} accessibilityLabel={`${name}, ${files} files`}
      style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{name}</Text>
        <Text variant="footnote" color="ink3">{files} files</Text>
      </View>
      {!open && <Text variant="caption" color="ink3" numberOfLines={2}>{summary}</Text>}
      <Collapse open={open}><Text variant="caption" color="ink2">{summary}</Text></Collapse>
    </Press>
  )
}
