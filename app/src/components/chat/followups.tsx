import { useCallback, useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated'
import { Cancel01Icon, CheckmarkCircle02Icon, Clock01Icon, HourglassIcon, MinusSignCircleIcon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { whenLabel } from '@/lib/format'
import type { Teammate } from '@/lib/types'
import { motion, useTheme } from '@/theme'
import { Badge, Icon, IconButton, Press, Sheet, Text, confirm, haptic, toast } from '@/ui'

/** A pending follow-up (GET /threads/:id/followups): a time (`at`) or a condition (`until`). */
export interface Followup {
  id: string
  what: string
  /** A teammate id, or "group". */
  owner: string
  at: string | null
  until: string | null
  check_by: string | null
  poll_hours: number | null
  /** Finished ones: how it ended, and when. */
  status?: 'fired' | 'done' | 'cancelled' | 'dropped'
  closed?: string
}

/** A chat's pending follow-ups. Reloads whenever `stamp` changes (the screen passes "a run just ended"). */
export function useFollowups(threadId: string, stamp: unknown) {
  const [list, setList] = useState<Followup[]>([])
  const [done, setDone] = useState<Followup[]>([])
  const load = useCallback(() => {
    api<{ pending: Followup[]; done: Followup[] }>(`/threads/${encodeURIComponent(threadId)}/followups`)
      .then((r) => { setList(r.pending); setDone(r.done) }, () => {})
  }, [threadId])
  useEffect(() => { load() }, [load, stamp])
  const cancel = async (f: Followup) => {
    haptic.tap()
    if (!await confirm({ title: 'Cancel this follow-up?', body: f.what, confirmLabel: 'Cancel follow-up', cancelLabel: 'Keep it', destructive: true })) return
    setList((l) => l.filter((x) => x.id !== f.id))
    try {
      await api(`/followups/${f.id}`, { method: 'DELETE' })
      toast({ title: 'Follow-up cancelled' })
      load()
    } catch (e) {
      toast({ title: 'Unable to cancel', body: (e as Error).message, tone: 'error' })
      load()
    }
  }
  return { list, done, load, cancel }
}

/** The header button: a clock with how many follow-ups are pending here. */
export function FollowupsButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <View>
      <IconButton
        icon={Clock01Icon}
        round
        color={count ? c.ink : c.ink3}
        accessibilityLabel={count ? `${count} pending follow-up${count > 1 ? 's' : ''}` : 'Follow-ups'}
        onPress={() => { haptic.tap(); onPress() }}
      />
      <View style={{ position: 'absolute', top: 6, right: 4 }}><Badge count={count} /></View>
    </View>
  )
}

/** What's pending in this chat, soonest first, each cancellable. */
export function FollowupsSheet({ open, onClose, list, done, people, onCancel }: {
  open: boolean; onClose: () => void; list: Followup[]; done: Followup[]; people: Teammate[]; onCancel: (f: Followup) => void
}) {
  const finished = done.filter((f) => f.status === 'fired' || f.status === 'done')
  const dropped = done.filter((f) => f.status === 'cancelled' || f.status === 'dropped')
  const ownerName = (f: Followup) => (f.owner === 'group' ? 'The group' : people.find((p) => p.id === f.owner)?.name ?? 'A teammate')
  return (
    <Sheet open={open} onClose={onClose} title="Follow-ups">
      <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 12 }}>
      <Text variant="caption" color="ink3" style={{ marginBottom: 12 }}>What this chat comes back to, and when. Tap one to read it all.</Text>
      {list.length > 0 && done.length > 0 && <Text variant="footnote" color="ink3" style={{ paddingBottom: 4 }}>Pending</Text>}
      {list.length === 0 && done.length > 0 ? (
        <Text variant="footnote" color="ink3" style={{ paddingVertical: 12 }}>Nothing pending right now.</Text>
      ) : list.length === 0 ? (
        <View style={{ paddingVertical: 24, alignItems: 'center', gap: 6 }}>
          <Icon icon={Clock01Icon} size={22} color="ink3" />
          <Text variant="label" color="ink2">Nothing pending</Text>
          <Text variant="footnote" color="ink3" style={{ textAlign: 'center' }}>
            Try “remind me at 6 to review the copy” or “deploy once the design is done”.
          </Text>
        </View>
      ) : (
        list.map((f) => <Row key={f.id} f={f} owner={ownerName(f)} onCancel={() => onCancel(f)} />)
      )}
      {[['Done', finished], ['Cancelled', dropped]].map(([label, rows]) => (rows as Followup[]).length > 0 && (
        <View key={label as string}>
          <Text variant="footnote" color="ink3" style={{ paddingTop: 16, paddingBottom: 4 }}>{label as string}</Text>
          {(rows as Followup[]).map((f) => <DoneRow key={f.id} f={f} owner={ownerName(f)} />)}
        </View>
      ))}
      </ScrollView>
    </Sheet>
  )
}

function Row({ f, owner, onCancel }: { f: Followup; owner: string; onCancel: () => void }) {
  const { c } = useTheme()
  const [full, setFull] = useState(false)
  const when = f.at
    ? whenLabel(f.at)
    : [`When ${f.until}`, f.check_by && `nudge by ${whenLabel(f.check_by)}`, f.poll_hours && `checks every ${f.poll_hours < 1 ? '30 min' : `${f.poll_hours} h`}`]
      .filter(Boolean).join(' · ')
  return (
    <Animated.View
      exiting={FadeOut.duration(motion.duration.quick)}
      layout={LinearTransition.duration(motion.duration.fast).easing(motion.ease.smoothOut)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.line }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
        <Icon icon={f.at ? Clock01Icon : HourglassIcon} size={17} color="ink2" />
      </View>
      <Press radius={10} static onPress={() => setFull((v) => !v)} accessibilityHint={full ? 'Shows less' : 'Shows it all'} outerStyle={{ flex: 1, minWidth: 0 }} style={{ gap: 2 }}>
        <Text variant="label" numberOfLines={full ? undefined : 2}>{f.what}</Text>
        <Text variant="footnote" color="ink3" numberOfLines={full ? undefined : 2}>{when} · {owner}</Text>
      </Press>
      <IconButton icon={Cancel01Icon} round size={36} iconSize={16} color={c.ink3} accessibilityLabel={`Cancel: ${f.what}`} onPress={onCancel} />
    </Animated.View>
  )
}

const ENDED: Record<NonNullable<Followup['status']>, string> = {
  fired: 'Picked up', done: 'Done', cancelled: 'Cancelled by you', dropped: 'Dropped, no longer needed',
}

/** A finished follow-up: how it ended and when, so nobody scrolls the chat to find out. */
function DoneRow({ f, owner }: { f: Followup; owner: string }) {
  const { c } = useTheme()
  const [full, setFull] = useState(false)
  const ok = f.status === 'fired' || f.status === 'done'
  const ended = [f.status ? ENDED[f.status] : 'Closed', f.closed && whenLabel(f.closed), owner].filter(Boolean).join(' · ')
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.line }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
        <Icon icon={ok ? CheckmarkCircle02Icon : MinusSignCircleIcon} size={17} color={ok ? 'success' : 'ink3'} />
      </View>
      <Press radius={10} static onPress={() => setFull((v) => !v)} accessibilityHint={full ? 'Shows less' : 'Shows it all'} outerStyle={{ flex: 1, minWidth: 0 }} style={{ gap: 2 }}>
        <Text variant="label" color="ink2" numberOfLines={full ? undefined : 2}>{f.what}</Text>
        <Text variant="footnote" color="ink3" numberOfLines={full ? undefined : 1}>{ended}</Text>
      </Press>
    </View>
  )
}
