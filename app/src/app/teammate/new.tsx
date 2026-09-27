import { router } from 'expo-router'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon } from '@hugeicons/core-free-icons'

import { SheetHeader } from '@/components/form-bits'
import { SheetScreen } from '@/components/sheet-screen'
import {
  TeammateFields, TeammatePreview, handleTakenError, validateTeammate, type DraftErrors, type TeammateDraft,
} from '@/components/teammate-form'
import { DEFAULT_MODEL, freeHandle, fromTemplate, roleName, useTemplates, type Template } from '@/lib/catalog'
import { supabase } from '@/lib/supabase'
import type { Teammate } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { radius, useTheme } from '@/theme'
import { Button, Icon, Press, TeammateAvatar, Text, haptic, toast } from '@/ui'

const BLANK: TeammateDraft = {
  name: '', handle: '', role: '', bio: '', system_prompt: '', model: DEFAULT_MODEL, allowed_toolkits: [], avatar_shape: 'circle', color: '#8bd4f7',
}

export default function NewTeammate() {
  const { c } = useTheme()
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const templates = useTemplates()
  const [picked, setPicked] = useState<string>('blank')
  const [draft, setDraft] = useState<TeammateDraft>(BLANK)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [saving, setSaving] = useState(false)

  const pick = (t: Template | null) => {
    haptic.tap()
    setPicked(t?.role ?? 'blank')
    setErrors({})
    setDraft(t ? { ...fromTemplate(t), handle: freeHandle(t.handle, ws.teammates) } : BLANK)
  }

  const save = async () => {
    const e = validateTeammate(draft, ws.teammates)
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const { data, error } = await supabase.from('teammates').insert({ ...draft, name: draft.name.trim(), role: draft.role.trim(), bio: draft.bio.trim() }).select().single()
    setSaving(false)
    if (error) {
      const taken = handleTakenError(error, draft.handle)
      if (taken) setErrors(taken)
      else toast({ title: 'Unable to add teammate', body: 'Check your connection and try again.', tone: 'error' })
      return
    }
    haptic.success()
    await ws.refresh()
    // Opened from a tab this closes the sheet first; opened by URL there is nothing to go back to.
    const next = { pathname: '/teammate/[id]', params: { id: (data as Teammate).id } } as const
    if (router.canGoBack()) { router.back(); router.push(next) } else router.replace(next)
    toast({ title: `${draft.name.trim()} joined your team`, tone: 'success' })
  }

  return (
    <SheetScreen>
      <SheetHeader title="New teammate" subtitle="Start from a role or from scratch." />
      <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 12, gap: 8 }}>
          <TemplateCard label="Blank" sub="From scratch" on={picked === 'blank'} onPress={() => pick(null)} />
          {templates.map((t) => (
            <TemplateCard key={t.role} template={t} label={t.name} sub={roleName(t.role)} on={picked === t.role} onPress={() => pick(t)} />
          ))}
        </ScrollView>
        <View style={{ paddingHorizontal: 20, gap: 32, paddingTop: 8 }}>
          <TeammatePreview draft={draft} />
          <TeammateFields value={draft} onChange={setDraft} errors={errors} />
        </View>
      </KeyboardAwareScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16), borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.panel }}>
        <Button label={draft.name.trim() ? `Add ${draft.name.trim()}` : 'Add teammate'} size="lg" fullWidth loading={saving} onPress={save} />
      </View>
    </SheetScreen>
  )
}

function TemplateCard({ template, label, sub, on, onPress }: { template?: Template; label: string; sub: string; on: boolean; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Press
      radius={radius.lg}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${label}, ${sub}`}
      style={{ width: 128, padding: 12, gap: 8, backgroundColor: on ? c.tubeSoft : c.panel2, borderWidth: 1.5, borderColor: on ? c.tube : c.line }}
    >
      {template ? (
        <TeammateAvatar teammate={template} size={36} interactive={false} paused={!on} />
      ) : (
        <View style={{ width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.ink4, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={Add01Icon} size={16} color="ink3" />
        </View>
      )}
      <View>
        <Text variant="label" numberOfLines={1}>{label}</Text>
        <Text variant="footnote" color="ink3" numberOfLines={1}>{sub}</Text>
      </View>
    </Press>
  )
}
