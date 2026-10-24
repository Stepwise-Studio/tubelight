// Every follow-up teammates agreed to, by state: Upcoming (has a time), Waiting (on something happening), Done and
// Cancelled. Opened from the Garage's Coming up; a pending one opens to change its time or cancel it.
import { useCallback, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ScreenHeader } from '@/components/screen-header'
import { FollowupList, FollowupSheet } from '@/components/tasks/followups'
import { useFollowups, type Followup } from '@/lib/tasks'
import { useTheme } from '@/theme'
import { Skeleton } from '@/ui'

export default function FollowupsScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const follow = useFollowups()
  const [refreshing, setRefreshing] = useState(false)
  const [sheet, setSheet] = useState<{ open: boolean; f: Followup | null; n: number }>({ open: false, f: null, n: 0 })
  const open = useCallback((f: Followup) => setSheet((x) => ({ open: true, f, n: x.n + 1 })), [])
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <ScreenHeader title="Follow-ups" />
      <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await follow.refresh(); setRefreshing(false) }}
          tintColor={c.ink3} colors={[c.tube]} progressBackgroundColor={c.panel} />}>
        {follow.pending === null
          ? <View style={{ padding: 20, gap: 14 }}><Skeleton width="60%" /><Skeleton width="40%" /></View>
          : <FollowupList pending={follow.pending} done={follow.done} onOpen={open} />}
      </ScrollView>
      <FollowupSheet key={`f${sheet.n}`} open={sheet.open} f={sheet.f} onClose={() => setSheet((x) => ({ ...x, open: false }))} />
    </View>
  )
}
