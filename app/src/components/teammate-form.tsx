// The teammate editor: used by /teammate/new and the Settings half of /teammate/[id].
import { useState } from 'react'
import { Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn, Keyframe } from 'react-native-reanimated'
import { AtIcon, SparklesIcon, Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons'

import { BrandTile } from '@/components/brand-mark'
import { ColorSwatches, FormSection } from '@/components/form-bits'
import { useSheet } from '@/components/sheet-screen'
import { api } from '@/lib/api'
import {
  COLORS, HANDLE_RE, MODEL_HINTS, PROVIDERS, connectApp, contextLabel, modelName, modelProvider, recommendedModel, toolkitName,
  useConnections, useModels, useToolkits, type Connection, type Toolkit,
} from '@/lib/catalog'
import type { Teammate } from '@/lib/types'
import { motion, radius, useTheme } from '@/theme'
import {
  Button, Chip, Divider, FACE_SEEDS, Icon, ListRow, SearchField, Sheet, Skeleton, Surface, TeammateAvatar, Text, TextField, Toggle, faceSeed,
  haptic, toast,
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

/** Twelve Notionists faces: the one the name draws, then fixed seeds (kept across renames). */
function FaceGrid({ draft, onPick }: { draft: TeammateDraft; onPick: (s: TeammateDraft['avatar_shape']) => void }) {
  const { c } = useTheme()
  const { width } = useWindowDimensions()
  const cols = 6
  const cell = Math.floor((Math.min(width, 520) - 40 - (cols - 1) * 6) / cols)
  const current = faceSeed({ ...draft, name: draft.name || 'Teammate' })
  const seeds = [draft.name.trim() || 'Teammate', ...FACE_SEEDS]
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Face">
      {seeds.map((seed, i) => {
        const on = seed === current
        return (
          <Pressable
            key={`${i}-${seed}`}
            accessibilityRole="radio"
            accessibilityLabel={i === 0 ? 'Face from their name' : `Face ${i + 1}`}
            accessibilityState={{ checked: on }}
            onPress={() => { if (!on) { haptic.tap(); onPick(`face:${seed}`) } }}
            style={{
              width: cell, height: cell, borderRadius: cell / 2, alignItems: 'center', justifyContent: 'center',
              borderWidth: 2, borderColor: on ? c.tube : 'transparent',
            }}
          >
            <TeammateAvatar teammate={{ avatar_shape: `face:${seed}`, color: draft.color, name: seed }} size={cell - 8} />
          </Pressable>
        )
      })}
    </View>
  )
}

function ModelField({ value, role, onChange }: { value: string; role: string; onChange: (id: string) => void }) {
  const { c } = useTheme()
  const { height } = useWindowDimensions()
  const { models, error } = useModels()
  const [open, setOpen] = useState(false)
  const current = models?.find((m) => m.id === value)
  const listed = new Set((models ?? []).map((m) => m.id))
  const suggested = MODEL_HINTS.filter((h) => listed.has(h.id))
  const forRole = role.trim() ? recommendedModel(role) : null
  const hint = MODEL_HINTS.find((h) => h.id === value)?.best
  const groups = Object.entries(
    (models ?? []).reduce<Record<string, typeof models & object>>((acc, m) => {
      (acc[m.provider] ??= []).push(m)
      return acc
    }, {}),
  ).sort(([a], [b]) => (a === 'groq' ? -1 : b === 'groq' ? 1 : a.localeCompare(b)))
  const pick = (id: string) => { haptic.tap(); onChange(id); setOpen(false) }
  const tick = (id: string) => (id === value ? <Icon icon={Tick02Icon} size={18} color={c.tube} strokeWidth={2} /> : null)

  return (
    <>
      <Surface style={{ overflow: 'hidden' }}>
        <ListRow
          title={modelName(value, models)}
          subtitle={hint ?? [PROVIDERS[modelProvider(value)], current && contextLabel(current.context_length)].filter(Boolean).join(' · ')}
          accessory={models ? <Icon icon={UnfoldMoreIcon} size={18} color="ink3" /> : null}
          onPress={models ? () => setOpen(true) : undefined}
          accessibilityLabel={`Model, ${modelName(value, models)}`}
          accessibilityHint="Choose a different model"
        />
      </Surface>
      {error && <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 2 }}>The model list is unavailable right now, so the current model stays. {error}</Text>}
      <Sheet open={open} onClose={() => setOpen(false)} title="Model">
        <ScrollView style={{ maxHeight: height * 0.66 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 8 }}>
          <Text variant="caption" color="ink3" style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
            Every model here is free: Groq and OpenRouter free tiers, and Cloudflare’s daily free allowance. If one is busy, the run falls back to another.
          </Text>
          {suggested.length > 0 && (
            <View>
              <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 12, paddingTop: 16, paddingBottom: 4 }}>Suggested</Text>
              {suggested.map((h) => (
                <ListRow
                  key={h.id}
                  title={modelName(h.id, models)}
                  subtitle={h.best}
                  accessory={
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {h.id === forRole && <Chip label={`For ${role.trim().toLowerCase()}`} tone="tube" />}
                      {tick(h.id)}
                    </View>
                  }
                  accessibilityLabel={`${modelName(h.id, models)}. ${h.best}${h.id === forRole ? '. Recommended for this role' : ''}${h.id === value ? ', selected' : ''}`}
                  onPress={() => pick(h.id)}
                />
              ))}
            </View>
          )}
          <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 12, paddingTop: 20, paddingBottom: 0 }}>All free models</Text>
          {groups.map(([provider, list]) => (
            <View key={provider}>
              <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 2 }}>{PROVIDERS[provider] ?? provider}</Text>
              {list.map((m) => (
                <ListRow
                  key={m.id}
                  title={modelName(m.id, models)}
                  subtitle={contextLabel(m.context_length)}
                  accessory={tick(m.id)}
                  accessibilityLabel={`${modelName(m.id, models)}, ${contextLabel(m.context_length)}${m.id === value ? ', selected' : ''}`}
                  onPress={() => pick(m.id)}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      </Sheet>
    </>
  )
}

/** The system prompt, with Enhance: an LLM rewrites the user's words into a clear brief (Undo restores them). */
function InstructionsField({ value, onChange, error }: { value: TeammateDraft; onChange: (v: string) => void; error?: string }) {
  const [busy, setBusy] = useState(false)
  const [before, setBefore] = useState<string | null>(null)
  const enhance = async () => {
    haptic.tap()
    setBusy(true)
    try {
      const { prompt } = await api<{ prompt: string }>('/teammates/enhance', {
        method: 'POST',
        json: { name: value.name, role: value.role, bio: value.bio, instructions: value.system_prompt, toolkits: value.allowed_toolkits },
      })
      setBefore(value.system_prompt)
      onChange(prompt)
      haptic.success()
    } catch (e) {
      toast({ title: 'Unable to enhance', body: (e as Error).message, tone: 'error' })
    } finally { setBusy(false) }
  }
  const empty = !value.system_prompt.trim() && !value.role.trim()
  return (
    <>
      <TextField
        value={value.system_prompt}
        onChangeText={(v) => { onChange(v); if (before !== null) setBefore(null) }}
        accessibilityLabel="Instructions"
        placeholder={`Describe what ${value.name.trim() || 'they'} should do, e.g. “Review my PRs, keep answers short, ask before merging.”`}
        multiline
        showCount
        maxLength={PROMPT_MAX}
        error={error}
        autoCapitalize="sentences"
        editable={!busy}
        inputStyle={{ fontSize: 14, lineHeight: 21, minHeight: 180, maxHeight: 380 }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Button label={busy ? 'Enhancing…' : 'Enhance'} icon={SparklesIcon} size="sm" variant="soft" loading={busy} disabled={empty} onPress={enhance} />
        {before !== null && !busy && (
          <Button label="Undo" size="sm" variant="ghost" onPress={() => { haptic.tap(); onChange(before); setBefore(null) }} />
        )}
        {empty && <Text variant="footnote" color="ink3" style={{ flex: 1 }}>Add a role or a few words first.</Text>}
      </View>
    </>
  )
}

export function connectionStatus(conn: Connection | undefined) {
  if (!conn) return 'Checking…'
  if (conn.status === 'unavailable') return 'Connectors are off on the server'
  if (conn.connected) return conn.account ? `Connected as ${conn.account}` : 'Connected'
  if (conn.status === 'initiated') return 'Waiting for you to finish signing in'
  if (conn.status === 'expired' || conn.status === 'failed') return 'Needs reconnecting'
  return 'Not connected'
}

const APP_ROWS = 8

/** The apps this teammate may use: the ones picked, then the most used, and a search across every app. */
function ToolkitPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { connections, reload } = useConnections()
  const { toolkits } = useToolkits()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const byId = new Map((toolkits ?? []).map((t) => [t.toolkit, t]))
  const status = (t: string) => connections?.find((x) => x.toolkit === t)
  const q = query.trim().toLowerCase()
  const picked = value.map((t): Toolkit => byId.get(t) ?? { toolkit: t, name: toolkitName(t), logo: '', description: '', categories: [], tools: 0, auth: 'oauth' })
  const rest = (toolkits ?? []).filter((t) => !value.includes(t.toolkit))
  const rows = q
    ? (toolkits ?? []).filter((t) => t.name.toLowerCase().includes(q) || t.toolkit.toLowerCase().includes(q) || t.categories.some((k) => k.includes(q))).slice(0, APP_ROWS)
    : [...picked, ...rest.slice(0, Math.max(0, APP_ROWS - picked.length))]
  const toggle = (t: string, on: boolean) => { haptic.tap(); onChange(on ? [...value, t] : value.filter((x) => x !== t)) }
  const connect = async (t: Toolkit) => {
    setBusy(t.toolkit)
    try { await connectApp(t.toolkit, t.name); await reload() } catch (e) {
      toast({ title: `Unable to connect ${t.name}`, body: (e as Error).message, tone: 'error' })
    } finally { setBusy(null) }
  }

  return (
    <>
      <SearchField value={query} onChangeText={setQuery} placeholder={toolkits ? `Search ${toolkits.length.toLocaleString()} apps` : 'Search apps'} />
      <Surface style={{ overflow: 'hidden' }}>
        {toolkits === null && rows.length === 0 && [0, 1, 2].map((i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
            <Skeleton width={36} height={36} radius={10} />
            <View style={{ flex: 1, gap: 6 }}><Skeleton width="40%" height={12} /><Skeleton width="60%" height={10} /></View>
          </View>
        ))}
        {rows.map((t, i) => {
          const on = value.includes(t.toolkit)
          const conn = status(t.toolkit)
          const ready = t.auth === 'none' || conn?.connected
          return (
            <View key={t.toolkit}>
              {i > 0 && <Divider inset={60} />}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14, paddingRight: 10, minHeight: 64 }}>
                <BrandTile toolkit={t.toolkit} size={36} />
                <View style={{ flex: 1, minWidth: 0, paddingVertical: 10 }}>
                  <Text variant="bodyMedium" numberOfLines={1}>{t.name}</Text>
                  <Text variant="footnote" color="ink3" numberOfLines={1}>
                    {t.auth === 'none' ? 'No sign-in needed' : conn ? connectionStatus(conn) : t.description || 'Not connected'}
                  </Text>
                </View>
                {on && !ready && conn?.status !== 'unavailable' && (
                  <Button label="Connect" size="sm" variant="soft" loading={busy === t.toolkit} onPress={() => connect(t)} />
                )}
                <Toggle value={on} onChange={(v) => toggle(t.toolkit, v)} label={`${t.name} for this teammate`} />
              </View>
            </View>
          )
        })}
        {q && toolkits && rows.length === 0 && <Text variant="caption" color="ink3" style={{ padding: 14 }}>No apps match “{query}”.</Text>}
      </Surface>
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
  // In a sheet, the heavier sections mount once it has slid in, so opening stays smooth.
  const ready = useSheet()?.ready ?? true
  return (
    <View style={{ gap: 32 }}>
      <FormSection title="Who they are">
        <TextField
          label="Name"
          value={value.name}
          onChangeText={(v) => onChange({ ...value, name: v, handle: followName(value, v) })}
          placeholder="Dev"
          error={errors.name}
          autoCapitalize="words"
          maxLength={40}
        />
        <TextField label="Role" value={value.role} onChangeText={(v) => set('role', v)} placeholder="Developer" error={errors.role} maxLength={60} />
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
        <TextField label="Bio" value={value.bio} onChangeText={(v) => set('bio', v)} placeholder="One line on how they work" multiline showCount maxLength={BIO_MAX} />
      </FormSection>

      <FormSection title="Instructions" hint="What they do and how they work. Write it in your own words, then Enhance turns it into a clear brief.">
        <InstructionsField value={value} onChange={(v) => set('system_prompt', v)} error={errors.system_prompt} />
      </FormSection>

      {ready ? (
        <Animated.View entering={FadeIn.duration(motion.duration.fast)} style={{ gap: 32 }}>
          <FormSection title="Model" hint="The model that writes their replies. All free.">
            <ModelField value={value.model} role={value.role} onChange={(v) => set('model', v)} />
          </FormSection>

          <FormSection title="Apps" hint="What this teammate may use. Sending, posting and pushing always wait for your approval.">
            <ToolkitPicker value={value.allowed_toolkits} onChange={(v) => set('allowed_toolkits', v)} />
          </FormSection>

          <FormSection title="Look">
            <FaceGrid draft={value} onPick={(s) => set('avatar_shape', s)} />
            <ColorSwatches colors={COLORS} value={value.color} onChange={(v) => set('color', v)} />
          </FormSection>
        </Animated.View>
      ) : (
        <View style={{ gap: 12 }}><Skeleton width="30%" height={12} /><Skeleton height={64} radius={16} /><Skeleton height={180} radius={16} /></View>
      )}
    </View>
  )
}
