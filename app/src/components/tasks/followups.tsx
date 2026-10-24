// Every chat's follow-ups in one place: what each teammate will come back to and when, grouped by day (and the ones
// waiting on something), editable. A change lands in its chat as a capsule and the teammate works from the new version.
import { router } from 'expo-router'
import { useState } from 'react'
import { ScrollView, TextInput, View } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { ArrowRight01Icon, CheckmarkCircle02Icon, HourglassIcon, MinusSignCircleIcon, UserGroupIcon } from '@hugeicons/core-free-icons'

import { clock, whenLabel } from '@/lib/format'
import { cancelFollowup, editFollowup, followupNow, isoDay, type Followup } from '@/lib/tasks'
import { useWorkspace } from '@/lib/workspace'
import { motion, type, useTheme } from '@/theme'
import {
  Button, Icon, Press, Segment, Sheet, Squircle, TeammateAvatar, Text, confirm, haptic, toast,
} from '@/ui'

import { ClockWheel } from './clock-wheel'
import { DayPicker } from './day-picker'

const layout = LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)

function dayHeading(iso: string, now = new Date()) {
  const d = new Date(iso)
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** Upcoming: has a time. Waiting: waits on something happening. Done: picked up or finished. Cancelled: called off
 * or no longer needed. */
type State = 'upcoming' | 'waiting' | 'done' | 'cancelled'
const STATES: { id: State; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' }, { id: 'waiting', label: 'Waiting' }, { id: 'done', label: 'Done' }, { id: 'cancelled', label: 'Cancelled' },
]
const EMPTY: Record<State, string> = {
  upcoming: 'Nothing scheduled. Ask a teammate to “check back on Friday at 5”.',
  waiting: 'Nothing waiting. Ask a teammate to “check back when the design is done”.',
  done: 'None finished yet.',
  cancelled: 'None cancelled.',
}

/** Follow-ups by state: a row of chips with counts and the picked state's list under it, full width. Upcoming ones are
 *  grouped by day. */
export function FollowupList({ pending, done, onOpen }: { pending: Followup[]; done: Followup[]; onOpen: (f: Followup) => void }) {
  const { c } = useTheme()
  const lists: Record<State, Followup[]> = {
    upcoming: pending.filter((f) => f.at).sort((a, b) => a.at!.localeCompare(b.at!)),
    waiting: pending.filter((f) => !f.at),
    done: done.filter((f) => f.status === 'fired' || f.status === 'done'),
    cancelled: done.filter((f) => f.status === 'cancelled' || f.status === 'dropped'),
  }
  const [state, setState] = useState<State>(lists.upcoming.length || !lists.waiting.length ? 'upcoming' : 'waiting')
  const count = (id: State) => lists[id].length
  const groups = new Map<string, Followup[]>()
  for (const f of lists.upcoming) groups.set(dayHeading(f.at!), [...(groups.get(dayHeading(f.at!)) ?? []), f])
  const order = [...groups.keys()]
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 4 }}>
        {STATES.map((x) => {
          const on = x.id === state
          return (
            <Press key={x.id} radius={18} static onPress={() => { haptic.tap(); setState(x.id) }} accessibilityRole="tab" accessibilityState={{ selected: on }}
              style={{ height: 36, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: on ? c.ink : c.panel2 }}>
              <Text variant="label" style={{ color: on ? c.canvas : c.ink2 }}>{x.label}</Text>
              <Text variant="label" tabular style={{ color: on ? c.canvas : c.ink3, opacity: 0.8 }}>{count(x.id)}</Text>
            </Press>
          )
        })}
      </ScrollView>
      {!lists[state].length ? (
        <Text variant="footnote" color="ink3" style={{ paddingHorizontal: 16, paddingVertical: 14 }}>{EMPTY[state]}</Text>
      ) : state === 'upcoming' ? (
        order.map((g) => (
          <Animated.View key={g} layout={layout}>
            <Text variant="overline" color="ink3" accessibilityRole="header" style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 }}>{g}</Text>
            {groups.get(g)!.map((f) => <FollowupRow key={f.id} f={f} onPress={() => onOpen(f)} />)}
          </Animated.View>
        ))
      ) : state === 'waiting' ? (
        <View style={{ paddingTop: 6 }}>{lists.waiting.map((f) => <FollowupRow key={f.id} f={f} onPress={() => onOpen(f)} />)}</View>
      ) : (
        <View style={{ paddingTop: 6 }}>{lists[state].map((f) => <FollowupRow key={f.id} f={f} finished />)}</View>
      )}
    </View>
  )
}

const ENDED: Record<string, string> = { fired: 'Picked up', done: 'Done', cancelled: 'Cancelled', dropped: 'No longer needed' }

function FollowupRow({ f, onPress, finished }: { f: Followup; onPress?: () => void; finished?: boolean }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const owner = f.owner === 'group' ? null : ws.teammate(f.owner)
  const where = ws.threadTitle(f.thread_id)
  const when = finished ? [f.status && ENDED[f.status], f.closed && whenLabel(f.closed)].filter(Boolean).join(' · ')
    : f.at ? clock(new Date(f.at)) : `When ${f.until}`
  const ok = f.status === 'fired' || f.status === 'done'
  return (
    <Animated.View layout={layout} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)}>
      <Press radius={0} disabled={finished} onPress={onPress} accessibilityLabel={`${f.what}. ${when}. ${where}`}
        accessibilityHint={finished ? undefined : 'Opens it to change or cancel'}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 11 }}>
        <View style={{ paddingTop: 1 }}>
          {finished ? (
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon icon={ok ? CheckmarkCircle02Icon : MinusSignCircleIcon} size={16} color={ok ? 'success' : 'ink3'} />
            </View>
          ) : owner ? <TeammateAvatar teammate={owner} size={32} interactive={false} /> : (
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon icon={UserGroupIcon} size={16} color="ink2" />
            </View>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text variant="body" color={finished ? 'ink3' : 'ink'} numberOfLines={2}>{f.what}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {!finished && !f.at && <Icon icon={HourglassIcon} size={12} color="ink3" />}
            <Text variant="footnote" color={!finished && f.at ? 'ink2' : 'ink3'} tabular={!!f.at} numberOfLines={1} style={{ flexShrink: 1 }}>{when}</Text>
            <Text variant="footnote" color="ink4">·</Text>
            <Text variant="footnote" color="ink3" numberOfLines={1} style={{ flexShrink: 1 }}>{where}</Text>
          </View>
        </View>
      </Press>
    </Animated.View>
  )
}

type Mode = 'time' | 'until'

/** Mount it with a new `key` for each opening: it starts from `f`. */
export function FollowupSheet({ f, open, onClose }: { f: Followup | null; open: boolean; onClose: () => void }) {
  const { c } = useTheme()
  const ws = useWorkspace()
  const [now] = useState(() => Date.now())
  const start = f?.at ? new Date(f.at) : new Date(now + 3600_000)
  const [what, setWhat] = useState(f?.what ?? '')
  const [mode, setMode] = useState<Mode>(f?.at || !f ? 'time' : 'until')
  const [day, setDay] = useState<string>(isoDay(start))
  const [hm, setHm] = useState<[number, number]>([start.getHours(), (Math.round(start.getMinutes() / 5) * 5) % 60])
  const [until, setUntil] = useState(f?.until ?? '')
  const [busy, setBusy] = useState<'' | 'save' | 'now' | 'cancel'>('')

  if (!f) return null
  const owner = f.owner === 'group' ? null : ws.teammate(f.owner)
  const at = new Date(`${day}T${String(hm[0]).padStart(2, '0')}:${String(hm[1]).padStart(2, '0')}`)
  const changed = what.trim() !== f.what || (mode === 'time' ? !f.at || at.getTime() !== new Date(f.at).getTime() : until.trim() !== (f.until ?? ''))
  const past = mode === 'time' && at.getTime() <= now

  const run = async (kind: 'save' | 'now' | 'cancel', call: () => Promise<unknown>, done: string) => {
    setBusy(kind)
    try {
      await call()
      haptic.success()
      toast({ title: done })
      onClose()
    } catch (e) {
      toast({ title: 'That didn’t work', body: (e as Error).message, tone: 'error' })
    } finally {
      setBusy('')
    }
  }

  return (
    <Sheet open={open} onClose={onClose} accessibilityLabel="Follow-up">
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 680 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 16, gap: 16 }}>
        <Press radius={12} static onPress={() => { onClose(); router.push({ pathname: '/chat/[threadId]', params: { threadId: f.thread_id } }) }}
          accessibilityLabel={`Open ${ws.threadTitle(f.thread_id)}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
          {owner ? <TeammateAvatar teammate={owner} size={28} interactive={false} /> : <Icon icon={UserGroupIcon} size={20} color="ink2" />}
          <View style={{ flex: 1 }}>
            <Text variant="label">{owner ? `${owner.name}’s follow-up` : 'The group’s follow-up'}</Text>
            <Text variant="footnote" color="ink3">in {ws.threadTitle(f.thread_id)}</Text>
          </View>
          <Icon icon={ArrowRight01Icon} size={16} color="ink3" />
        </Press>

        <TextInput cursorColor={c.tube} selectionColor={c.tube} selectionHandleColor={c.tube} value={what} onChangeText={setWhat} multiline maxLength={500} placeholder="What to do then"
          placeholderTextColor={c.ink4} accessibilityLabel="What to do then"
          style={[type.headline, { color: c.ink, padding: 0, minHeight: 44 }]} />

        <Segment<Mode> value={mode} onChange={setMode} accessibilityLabel="When"
          options={[{ value: 'time', label: 'At a time' }, { value: 'until', label: 'When something happens' }]} />

        {mode === 'time' ? (
          <View style={{ gap: 12 }}>
            <Squircle style={{ borderRadius: 20, borderWidth: 1, borderColor: c.line, backgroundColor: c.panel, padding: 14 }}>
              <DayPicker value={day} onChange={setDay} min={isoDay(new Date(now))} />
            </Squircle>
            <ClockWheel hour={hm[0]} minute={hm[1]} onChange={(h, m) => setHm([h, m])} bg={c.panel} />
            <Text variant="footnote" color={past ? 'danger' : 'ink3'}>
              {past ? 'That time has passed. Pick a later one.' : `${at.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}, ${clock(at)}`}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            <Text variant="label" color="ink3">It happens when</Text>
            <TextInput cursorColor={c.tube} selectionColor={c.tube} selectionHandleColor={c.tube} value={until} onChangeText={setUntil} maxLength={300} placeholder="the design tweak is done"
              placeholderTextColor={c.ink4} accessibilityLabel="It happens when"
              style={[type.body, { color: c.ink, borderWidth: 1, borderColor: c.edge, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: c.panel }]} />
            <Text variant="footnote" color="ink3">The chat is watched for it; {owner?.name ?? 'the group'} picks it up then.</Text>
          </View>
        )}

        <View style={{ gap: 8 }}>
          <Button label="Save changes" fullWidth size="lg" loading={busy === 'save'}
            disabled={!changed || !what.trim() || past || (mode === 'until' && !until.trim())}
            onPress={() => run('save', () => editFollowup(f.id, {
              what: what.trim(), ...(mode === 'time' ? { at: at.toISOString() } : { until: until.trim() }),
            }), 'Follow-up changed')} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label="Do it now" variant="soft" fullWidth loading={busy === 'now'}
                onPress={() => run('now', () => followupNow(f.id), `${owner?.name ?? 'The group'} is on it`)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Cancel it" variant="ghost" fullWidth loading={busy === 'cancel'}
                onPress={async () => {
                  if (!await confirm({ title: 'Cancel this follow-up?', body: f.what, confirmLabel: 'Cancel follow-up', cancelLabel: 'Keep it', destructive: true })) return
                  run('cancel', () => cancelFollowup(f.id), 'Follow-up cancelled')
                }} />
            </View>
          </View>
        </View>
      </ScrollView>
    </Sheet>
  )
}
