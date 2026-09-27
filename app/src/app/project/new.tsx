import { router } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Add01Icon, Link01Icon } from '@hugeicons/core-free-icons'

import { ColorSwatches, FormSection, SheetHeader, TeammateToggles } from '@/components/form-bits'
import { SheetScreen } from '@/components/sheet-screen'
import { COLORS, REPO_RE } from '@/lib/catalog'
import { supabase } from '@/lib/supabase'
import type { Project } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Button, Text, TextField, haptic, toast } from '@/ui'

export default function NewProject() {
  const { c } = useTheme()
  const ws = useWorkspace()
  const insets = useSafeAreaInsets()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repo, setRepo] = useState('')
  const [color, setColor] = useState(COLORS[1].value)
  const [members, setMembers] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<{ name?: string; repo?: string }>({})
  const [saving, setSaving] = useState(false)

  const toggle = (id: string) => setMembers((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const create = async () => {
    const e: typeof errors = {}
    if (!name.trim()) e.name = 'Give the project a name.'
    if (repo.trim() && !REPO_RE.test(repo.trim())) e.repo = 'Paste the full address, like https://github.com/you/repo.'
    setErrors(e)
    if (Object.keys(e).length) return
    setSaving(true)
    const { data, error } = await supabase.from('projects')
      .insert({ name: name.trim(), description: description.trim(), repo_url: repo.trim() || null, color })
      .select().single()
    if (error) { setSaving(false); toast({ title: 'Unable to create the project', body: 'Check your connection and try again.', tone: 'error' }); return }
    const project = data as Project
    if (members.size) {
      const { error: mErr } = await supabase.from('project_members').insert([...members].map((teammate_id) => ({ project_id: project.id, teammate_id })))
      if (mErr) toast({ title: 'Project created, but members weren’t added', body: 'Add them from project settings.', tone: 'error' })
    }
    await ws.refresh()
    haptic.success()
    // Opened from a tab this closes the sheet first; opened by URL there is nothing to go back to.
    const next = { pathname: '/chat/[threadId]', params: { threadId: `proj:${project.id}` } } as const
    if (router.canGoBack()) { router.back(); router.push(next) } else router.replace(next)
  }

  return (
    <SheetScreen>
      <SheetHeader title="New project" subtitle="A group chat where teammates work together." />
      <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, gap: 32 }}>
        <FormSection title="Details">
          <TextField label="Name" value={name} onChangeText={setName} placeholder="Stepwise UI" error={errors.name} autoCapitalize="words" maxLength={60} />
          <TextField label="Description" value={description} onChangeText={setDescription} placeholder="What the team is working on" multiline showCount maxLength={280} hint="Every member reads this before replying." />
          <TextField
            label="Repository (optional)"
            icon={Link01Icon}
            value={repo}
            onChangeText={setRepo}
            placeholder="https://github.com/you/repo"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            error={errors.repo}
            hint="Teammates get a copy of it in their sandbox."
          />
        </FormSection>
        <FormSection title="Colour">
          <ColorSwatches colors={COLORS} value={color} onChange={setColor} />
        </FormSection>
        <FormSection title="Members" hint={ws.teammates.length ? 'Who’s in the chat. You can change this later.' : undefined}>
          {ws.teammates.length ? (
            <TeammateToggles teammates={ws.teammates} selected={members} onToggle={toggle} />
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Text variant="caption" color="ink3" style={{ flex: 1 }}>You don’t have any teammates yet. Add one first, then bring them in.</Text>
              <Button label="New teammate" size="sm" variant="soft" icon={Add01Icon} onPress={() => { router.back(); router.push('/teammate/new') }} />
            </View>
          )}
        </FormSection>
      </KeyboardAwareScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: Math.max(insets.bottom, 16), borderTopWidth: 1, borderTopColor: c.line }}>
        <Button
          label={members.size ? `Create with ${members.size} ${members.size === 1 ? 'member' : 'members'}` : 'Create project'}
          size="lg"
          fullWidth
          loading={saving}
          onPress={create}
        />
      </View>
    </SheetScreen>
  )
}
