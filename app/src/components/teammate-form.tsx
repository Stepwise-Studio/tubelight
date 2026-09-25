// The teammate editor: used by /teammate/new and the Settings half of /teammate/[id].
import { router } from 'expo-router'
import { useState } from 'react'
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import Animated, { Keyframe } from 'react-native-reanimated'
import { AtIcon, Tick02Icon } from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { ColorSwatches, FormSection, SwitchRow } from '@/components/form-bits'
import {
  COLORS, HANDLE_RE, PROVIDERS, SHAPES, TOOLKITS, contextLabel, modelName, modelProvider, toolkitName,
  useConnections, useModels, type Connection,
} from '@/lib/catalog'
import type { Teammate } from '@/lib/types'
import { motion, radius, type as typeScale, useTheme } from '@/theme'
import {
  Button, Divider, Icon, ListRow, Sheet, Surface, TeammateAvatar, Text, TextField, haptic,
} from '@/ui'

export type TeammateDraft = Pick<Teammate, 'name' | 'handle' | 'role' | 'bio' | 'system_prompt' | 'model' | 'allowed_toolkits' | 'avatar_shape' | 'color'>
export type DraftErrors = Partial<Record<'name' | 'handle' | 'role' | 'system_prompt', string>>

export const PROMPT_MAX = 8000
export const BIO_MAX = 160

/** Validate before saving. Handles are unique per user. */
export function validateTeammate(d: TeammateDraft, others: Teammate[], selfId?: string): DraftErrors {
  const e: DraftErrors = {}
  if (!d.name.trim()) e.name = 'Give your teammate a name.'
  if (!d.handle) e.handle = 'Pick a handle, like dev.'
  else if (!HANDLE_RE.test(d.handle)) e.handle = 'Use 1 to 24 lowercase letters, numbers, - or _, starting with a letter or number.'
  else if (others.some((t) => t.handle === d.handle && t.id !== selfId)) e.handle = `@${d.handle} is taken. Pick another handle.`
  if (!d.role.trim()) e.role = 'Say what this teammate does, like “Developer”.'
  if (!d.system_prompt.trim()) e.system_prompt = 'Describe how this teammate should think and work.'
  else if (d.system_prompt.length > PROMPT_MAX) e.system_prompt = `Keep it under ${PROMPT_MAX.toLocaleString()} characters.`
  return e
}

/** Maps a Postgres unique violation on (owner_id, handle) to the handle field. */
export const handleTakenError = (err: { code?: string } | null, handle: string): DraftErrors | null =>
  err?.code === '23505' ? { handle: `@${handle} is taken. Pick another handle.` } : null

export const draftOf = (t: Teammate): TeammateDraft => ({
  name: t.name, handle: t.handle, role: t.role, bio: t.bio, system_prompt: t.system_prompt, model: t.model,
  allowed_toolkits: t.allowed_toolkits, avatar_shape: t.avatar_shape, color: t.color,
})

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)

/** The handle follows the name until you edit it yourself. */
const followName = (d: TeammateDraft, name: string) => (!d.handle || d.handle === slug(d.name) ? slug(name) : d.handle)

export const sameDraft = (a: TeammateDraft, b: TeammateDraft) => JSON.stringify(a) === JSON.stringify(b)

// The preview settles in when the face changes: modal-style 0.96 → 1, 250ms smooth out.
const settle = new Keyframe({
  0: { opacity: 0.4, transform: [{ scale: motion.scale.large }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: motion.ease.smoothOut },
}).duration(motion.duration.fast)

/** Large live preview of the draft. Tap it to make it hop. */
export function TeammatePreview({ draft }: { draft: TeammateDraft }) {
  return (
    <Surface tone="panel2" radius={radius.xl} padding={20} style={{ alignItems: 'center', gap: 12 }}>
      {/* Reanimated web leaves keyframe entrances hidden; web is only a preview. */}
      <Animated.View key={draft.avatar_shape + draft.color} entering={Platform.OS === 'web' ? undefined : settle}>
        <TeammateAvatar teammate={{ ...draft, name: draft.name || 'New teammate' }} size={96} live />
      </Animated.View>
      <View style={{ alignItems: 'center', gap: 2, maxWidth: '100%' }}>
        <Text variant="heading" numberOfLines={1}>{draft.name.trim() || 'Unnamed'}</Text>
        <Text variant="caption" color="ink3" numberOfLines={1}>
          {[draft.handle && `@${draft.handle}`, draft.role.trim()].filter(Boolean).join(' · ') || 'Pick a name and a role'}
        </Text>
      </View>
    </Surface>
  )
}

function ShapeGrid({ draft, onPick }: { draft: TeammateDraft; onPick: (s: TeammateDraft['avatar_shape']) => void }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const cols = 6
  const cell = Math.floor((Math.min(width, 520) - 40 - (cols - 1) * 6) / cols)
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Face">
      {SHAPES.map((s) => {
        const on = s === draft.avatar_shape
        return (
          <Pressable
            key={s}
            accessibilityRole="radio"
            accessibilityLabel={s}
            accessibilityState={{ checked: on }}
            onPress={() => { if (!on) { haptic.tap(); onPick(s) } }}
            style={{
              width: cell, height: cell, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
              backgroundColor: on ? c.tubeSoft : c.panel2, borderWidth: 1.5, borderColor: on ? c.tube : 'transparent',
            }}
          >
            <TeammateAvatar teammate={{ avatar_shape: s, color: draft.color, name: s }} size={Math.round(cell * 0.72)} interactive={false} />
          </Pressable>
        )
      })}
    </View>
  )
}

function ModelField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { c } = useTheme()
  const { height } = useWindowDimensions()
  const { models, error } = useModels()
  const [open, setOpen] = useState(false)
  const current = models?.find((m) => m.id === value)
  const groups = Object.entries(
    (models ?? []).reduce<Record<string, typeof models & object>>((acc, m) => {
      (acc[m.provider] ??= []).push(m)
      return acc
    }, {}),
  ).sort(([a], [b]) => (a === 'groq' ? -1 : b === 'groq' ? 1 : a.localeCompare(b)))

  return (
    <>
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow
          title={modelName(value, models)}
          subtitle={[PROVIDERS[modelProvider(value)], current && contextLabel(current.context_length)].filter(Boolean).join(' · ')}
          chevron={!!models}
          onPress={models ? () => setOpen(true) : undefined}
          accessibilityLabel={`Model, ${modelName(value, models)}`}
          accessibilityHint="Choose a different model"
        />
      </Surface>
      {error && <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 2 }}>The model list is unavailable right now, so the current model stays. {error}</Text>}
      <Sheet open={open} onClose={() => setOpen(false)} title="Model">
        <ScrollView style={{ maxHeight: height * 0.62 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          <Text variant="caption" color="ink3" style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
            Free models that can use tools. If one is busy, the run falls back to another provider.
          </Text>
          {groups.map(([provider, list]) => (
            <View key={provider}>
              <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 12, paddingTop: 20, paddingBottom: 4 }}>{PROVIDERS[provider] ?? provider}</Text>
              {list.map((m) => (
                <ListRow
                  key={m.id}
                  title={modelName(m.id, models)}
                  subtitle={contextLabel(m.context_length)}
                  accessory={m.id === value ? <Icon icon={Tick02Icon} size={18} color={c.tube} strokeWidth={2} /> : null}
                  accessibilityLabel={`${modelName(m.id, models)}, ${contextLabel(m.context_length)}${m.id === value ? ', selected' : ''}`}
                  onPress={() => { haptic.tap(); onChange(m.id); setOpen(false) }}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      </Sheet>
    </>
  )
}

/** "GitHub, Linear and Notion" */
const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

export function connectionStatus(conn: Connection | undefined) {
  if (!conn) return 'Checking…'
  if (conn.status === 'unavailable') return 'Connectors are off on the server'
  if (conn.connected) return conn.account ? `Connected as ${conn.account}` : 'Connected'
  if (conn.status === 'initiated') return 'Waiting for you to finish signing in'
  if (conn.status === 'expired' || conn.status === 'failed') return 'Needs reconnecting'
  return 'Not connected'
}

function ToolkitToggles({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { connections } = useConnections()
  const all = [...TOOLKITS, ...value.filter((t) => !(TOOLKITS as readonly string[]).includes(t))]
  const find = (t: string) => connections?.find((x) => x.toolkit === t)
  const missing = value.filter((t) => { const cn = find(t); return cn && !cn.connected && cn.status !== 'unavailable' })
  const toggle = (t: string, on: boolean) => onChange(on ? [...value, t] : value.filter((x) => x !== t))
  return (
    <>
      <Surface style={{ overflow: 'hidden' }}>
        {all.map((t, i) => {
          const on = value.includes(t)
          const conn = find(t)
          return (
            <View key={t}>
              {i > 0 && <Divider inset={60} />}
              <SwitchRow
                title={toolkitName(t)}
                subtitle={connections ? connectionStatus(conn) : 'Checking connection…'}
                leading={<BrandTile toolkit={t} size={36} />}
                value={on}
                onChange={(v) => toggle(t, v)}
                hint={on ? 'Stops this teammate using it' : 'Lets this teammate use it'}
              />
            </View>
          )
        })}
      </Surface>
      {missing.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 2 }}>
          <Text variant="footnote" color="ink3" style={{ flex: 1 }}>
            {listJoin(missing.map(toolkitName))} {missing.length === 1 ? 'isn’t' : 'aren’t'} connected yet, so this teammate can’t use {missing.length === 1 ? 'it' : 'them'} until you connect.
          </Text>
          <Button label="Connect" size="sm" variant="soft" onPress={() => router.push('/connections')} />
        </View>
      )}
    </>
  )
}

/** Every editable field of a teammate, grouped. */
export function TeammateFields({ value, onChange, errors }: {
  value: TeammateDraft
  onChange: (next: TeammateDraft) => void
  errors: DraftErrors
}) {
  const set = <K extends keyof TeammateDraft>(k: K, v: TeammateDraft[K]) => onChange({ ...value, [k]: v })
  return (
    <View style={{ gap: 32 }}>
      <FormSection title="Identity">
        <TextField
          label="Name"
          value={value.name}
          onChangeText={(v) => onChange({ ...value, name: v, handle: followName(value, v) })}
          placeholder="Dev"
          error={errors.name}
          autoCapitalize="words"
          maxLength={40}
        />
        <TextField
          label="Handle"
          icon={AtIcon}
          value={value.handle}
          onChangeText={(v) => set('handle', v.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
          placeholder="dev"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={24}
          error={errors.handle}
          hint="What you type to @mention them in a project."
        />
        <TextField label="Role" value={value.role} onChangeText={(v) => set('role', v)} placeholder="Developer" error={errors.role} maxLength={60} />
        <TextField label="Bio" value={value.bio} onChangeText={(v) => set('bio', v)} placeholder="One line on how they work" multiline showCount maxLength={BIO_MAX} />
      </FormSection>

      <FormSection title="Face">
        <ShapeGrid draft={value} onPick={(s) => set('avatar_shape', s)} />
        <ColorSwatches colors={COLORS} value={value.color} onChange={(v) => set('color', v)} />
      </FormSection>

      <FormSection title="Model" hint="The model that writes their replies.">
        <ModelField value={value.model} onChange={(v) => set('model', v)} />
      </FormSection>

      <FormSection title="Tools" hint="Apps this teammate may use. Sending, posting and pushing always wait for your approval.">
        <ToolkitToggles value={value.allowed_toolkits} onChange={(v) => set('allowed_toolkits', v)} />
      </FormSection>

      <FormSection title="Instructions" hint="How they think, work and talk. This is their system prompt.">
        <TextField
          value={value.system_prompt}
          onChangeText={(v) => set('system_prompt', v)}
          accessibilityLabel="Instructions"
          placeholder="You are Dev, the senior engineer on the team…"
          multiline
          showCount
          maxLength={PROMPT_MAX}
          error={errors.system_prompt}
          autoCapitalize="sentences"
          inputStyle={{ ...typeScale.mono, fontSize: 13, lineHeight: 20, minHeight: 240, maxHeight: 380 }}
        />
      </FormSection>
    </View>
  )
}
