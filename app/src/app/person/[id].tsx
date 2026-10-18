// A person (or company, project, place) as memory knows them: who they are to you, what's open with them, what's true
// now, what changed, and, for every fact, the words it came from. "That's wrong" retracts a fact for good (with what's
// right, if you say); the ⋯ menu forgets them everywhere.
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Call02Icon, Delete02Icon, Mail01Icon, MoreHorizontalIcon, AtIcon } from '@hugeicons/core-free-icons'

import { KIND_LABEL, PersonMark } from '@/components/people'
import { ScreenHeader } from '@/components/screen-header'
import { api } from '@/lib/api'
import { shortDate } from '@/lib/format'
import type { Fact, FactSource, PersonDetail } from '@/lib/types'
import { useTheme } from '@/theme'
import {
  Button, Chip, EmptyState, IconButton, Press, SectionHeader, Sheet, Skeleton, Squircle, Text, TextField, confirm, haptic,
  showMenu, toast,
} from '@/ui'

const ID_ICON = { phone: Call02Icon, email: Mail01Icon, handle: AtIcon }

function meta(f: Fact) {
  const from = f.trust === 0 ? 'unconfirmed, from outside content' : f.trust === 2 ? 'you said' : 'a teammate said'
  if (f.status === 'retracted') return `Wrong${f.valid_to ? `, corrected ${shortDate(f.valid_to)}` : ''}`
  if (f.status === 'tentative') return `Not sure yet · ${from}`
  if (f.status === 'faded') return `Faded: it never came up again · ${from}`
  if (f.status === 'closed') return `${f.valid_from ? `${shortDate(f.valid_from)} to ` : 'Until '}${f.valid_to ? shortDate(f.valid_to) : 'later'} · no longer true`
  if (f.kind === 'commitment') {
    if (f.done) return `Done${f.valid_to ? ` ${shortDate(f.valid_to)}` : ''}`
    return [f.due ? `Due ${shortDate(f.due)}` : 'Open', from].join(' · ')
  }
  return [f.valid_from ? `Since ${shortDate(f.valid_from)}` : null, from].filter(Boolean).join(' · ')
}

function where(s: FactSource) {
  const how = { chat: 'in a chat', call: 'on a call', note: s.speaker === 'the user' ? 'your correction' : 'a note', import: 'earlier notes' }[s.source]
  const who = s.speaker.replace(/^caller /, '').replace(/^app /, '')
  return `${s.source === 'note' || s.source === 'import' ? how : `${who} ${how}`} · ${shortDate(s.occurred_at)}`
}

export default function PersonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const [p, setP] = useState<PersonDetail | null | undefined>(undefined)
  const [open, setOpen] = useState<Fact | null>(null)

  const load = useCallback(() => api<PersonDetail>(`/people/${id}`).then(setP, (e: Error) => {
    setP((x) => x ?? null)
    toast({ title: 'Unable to load this', body: e.message, tone: 'error' })
  }), [id])
  useEffect(() => { load() }, [load])

  const forget = async () => {
    if (!p) return
    const ok = await confirm({
      title: `Forget ${p.name}?`, body: 'Every fact about them, their names and numbers are removed. Your chats stay as they are.',
      confirmLabel: `Forget ${p.name}`, destructive: true,
    })
    if (!ok) return
    try {
      await api(`/people/${p.id}`, { method: 'DELETE' })
      haptic.success()
      router.back()
    } catch (e) {
      toast({ title: 'Unable to forget them', body: (e as Error).message, tone: 'error' })
    }
  }

  const header = (
    <ScreenHeader title={p?.name ?? ''} right={p && p.kind !== 'user' ? (
      <IconButton icon={MoreHorizontalIcon} accessibilityLabel="More" onPress={() => showMenu({
        items: [{ label: `Forget ${p.name}`, icon: Delete02Icon, destructive: true, onPress: forget }],
      })} />
    ) : undefined} />
  )
  if (p === undefined) {
    return (
      <View style={{ flex: 1 }}>
        {header}
        <View style={{ padding: 16, gap: 12, alignItems: 'center' }}>
          <Skeleton width={64} height={64} radius={32} />
          <Skeleton width={160} height={24} radius={8} />
          {[0, 1, 2].map((i) => <Skeleton key={i} height={56} radius={12} />)}
        </View>
      </View>
    )
  }
  if (p === null) {
    return <View style={{ flex: 1 }}>{header}<EmptyState title="Not found" body="They may have been forgotten." /></View>
  }

  const owed = p.facts.filter((f) => f.status === 'current' && f.kind === 'commitment' && !f.done)
  const now = p.facts.filter((f) => f.status === 'current' && !owed.includes(f) && !(f.kind === 'commitment' && f.done))
  const unsure = p.facts.filter((f) => f.status === 'tentative')
  const earlier = p.facts.filter((f) => !owed.includes(f) && !now.includes(f) && !unsure.includes(f))

  return (
    <View style={{ flex: 1 }}>
      {header}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 24 }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <PersonMark person={p} size={64} />
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Text variant="title" align="center">{p.name}</Text>
            <Text variant="caption" color="ink3" align="center">
              {[KIND_LABEL[p.kind], p.aliases.length ? `also ${p.aliases.slice(0, 3).join(', ')}` : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {p.ids.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, paddingTop: 4 }}>
              {p.ids.map((x) => (
                <Chip key={x.type + x.value} label={x.value} icon={ID_ICON[x.type]}
                  onPress={x.type === 'handle' ? undefined : () => Linking.openURL(x.type === 'phone' ? `tel:${x.value}` : `mailto:${x.value}`)} />
              ))}
            </View>
          )}
          {p.profile ? <Text variant="body" color="ink2" align="center" style={{ maxWidth: 520, paddingTop: 4 }}>{p.profile}</Text> : null}
        </View>

        {owed.length > 0 && <Group title="Open" facts={owed} onOpen={setOpen} />}
        {now.length > 0 && <Group title="What's true now" facts={now} onOpen={setOpen} />}
        {unsure.length > 0 && <Group title="Not sure yet" facts={unsure} onOpen={setOpen} />}
        {earlier.length > 0 && <Group title="Earlier" facts={earlier} onOpen={setOpen} />}
        {p.facts.length === 0 && <Text variant="caption" color="ink3" align="center">Nothing on record about them yet.</Text>}
      </ScrollView>
      <FactSheet fact={open} onClose={() => setOpen(null)} onChanged={load} />
    </View>
  )
}

function Group({ title, facts, onOpen }: { title: string; facts: Fact[]; onOpen: (f: Fact) => void }) {
  const { c } = useTheme()
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={title} />
      <Squircle style={{ backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 4 }}>
        {facts.map((f, i) => {
          const gone = f.status !== 'current' || !!f.done
          return (
            <View key={f.id}>
              {i > 0 && <View style={{ height: 1, backgroundColor: c.line, marginHorizontal: 12 }} />}
              <Press radius={12} static onPress={() => onOpen(f)} accessibilityLabel={f.text} accessibilityHint="Shows where this came from"
                style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}>
                <Text variant="body" color={gone ? 'ink3' : 'ink'} style={f.status === 'retracted' ? { textDecorationLine: 'line-through' } : undefined}>{f.text}</Text>
                <Text variant="footnote" color={f.trust === 0 && !gone ? 'warning' : 'ink3'}>{meta(f)}</Text>
              </Press>
            </View>
          )
        })}
      </Squircle>
    </View>
  )
}

function FactSheet({ fact, onClose, onChanged }: { fact: Fact | null; onClose: () => void; onChanged: () => void }) {
  const { c } = useTheme()
  const [fixing, setFixing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(fact)
  if (fact && fact !== shown) { setShown(fact); setFixing(false); setText('') }
  const f = fact ?? shown

  const wrong = async () => {
    if (!f) return
    setBusy(true)
    try {
      await api(`/people/facts/${f.id}/wrong`, { method: 'POST', json: { text: text.trim() } })
      haptic.success()
      toast({ title: text.trim() ? 'Corrected' : 'Marked as wrong', body: 'Teammates won’t use it again.' })
      onClose()
      onChanged()
    } catch (e) {
      toast({ title: 'Unable to change that', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={!!fact} onClose={onClose} title="Fact">
      {f && (
        <ScrollView style={{ maxHeight: 560 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 16 }}>
          <View style={{ gap: 4 }}>
            <Text variant="headline">{f.text}</Text>
            <Text variant="caption" color="ink3">{meta(f)}</Text>
          </View>
          {f.sources.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text variant="label" color="ink2">Where it came from</Text>
              {f.sources.map((s, i) => (
                <View key={i} style={{ gap: 4 }}>
                  <Squircle style={{ backgroundColor: c.panel2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
                    <Text variant="body" color="ink2">{`“${s.quote}”`}</Text>
                  </Squircle>
                  <Text variant="footnote" color="ink3">
                    {s.role === 'done' ? 'Marked done: ' : s.role === 'wrong' ? 'Shown wrong: ' : ''}{where(s)}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {f.status !== 'retracted' && (fixing ? (
            <View style={{ gap: 12 }}>
              <TextField label="What's right? (optional)" value={text} onChangeText={setText} multiline maxLength={400}
                placeholder="Leave empty to just mark it wrong" />
              <Button label={text.trim() ? 'Save correction' : 'Mark as wrong'} variant="destructive" loading={busy} onPress={wrong} fullWidth />
            </View>
          ) : (
            <Button label="That's wrong" variant="soft" onPress={() => setFixing(true)} fullWidth />
          ))}
        </ScrollView>
      )}
    </Sheet>
  )
}
