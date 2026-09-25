import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { Add01Icon, Delete02Icon } from '@hugeicons/core-free-icons'

import { api } from '@/lib/api'
import { motion, useTheme } from '@/theme'
import { Divider, Icon, IconButton, Press, Skeleton, Surface, Text, TextField, haptic, showMenu, toast } from '@/ui'

interface Memory { key: string; text: string; created_at: string; updated_at: string }

/**
 * Long-term facts for a teammate or project. Add one, swipe left or long-press to delete (with undo).
 */
export function MemoryList({ scope, id, owner }: { scope: 'teammate' | 'project'; id: string; owner: string }) {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(() => api<Memory[]>(`/memories?scope=${scope}&id=${id}`).then(
    (list) => { setItems([...list].sort((a, b) => b.created_at.localeCompare(a.created_at))); setError(null) },
    (e: Error) => { setError(e.message); setItems([]) },
  ), [scope, id])
  useEffect(() => { load() }, [load])

  const add = async (text = draft.trim()) => {
    if (!text) return
    setAdding(true)
    try {
      await api('/memories', { method: 'POST', json: { scope, id, text } })
      setDraft('')
      haptic.success()
      await load()
    } catch (e) {
      toast({ title: 'Unable to save that fact', body: (e as Error).message, tone: 'error' })
    } finally { setAdding(false) }
  }

  const remove = async (m: Memory) => {
    setItems((l) => l?.filter((x) => x.key !== m.key) ?? l)
    try {
      await api(`/memories?scope=${scope}&id=${id}&key=${encodeURIComponent(m.key)}`, { method: 'DELETE' })
      toast({ title: 'Forgot one fact', body: m.text, action: { label: 'Undo', onPress: () => add(m.text) } })
    } catch (e) {
      toast({ title: 'Unable to delete that fact', body: (e as Error).message, tone: 'error' })
      load()
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <TextField
          value={draft}
          onChangeText={setDraft}
          placeholder={scope === 'project' ? 'Design tokens live in packages/tokens' : 'Prefers PRs under 200 lines'}
          accessibilityLabel={`Add a fact ${owner} should remember`}
          returnKeyType="done"
          onSubmitEditing={() => add()}
          style={{ flex: 1 }}
        />
        <IconButton
          icon={Add01Icon}
          variant="soft"
          size={48}
          accessibilityLabel="Add fact"
          disabled={!draft.trim() || adding}
          onPress={() => add()}
        />
      </View>
      {items === null ? (
        <Surface padding={16} style={{ gap: 10 }}>
          <Skeleton width="80%" />
          <Skeleton width="60%" />
        </Surface>
      ) : items.length === 0 ? (
        <Text variant="caption" color="ink3" style={{ paddingHorizontal: 2 }}>
          {error ?? (scope === 'project'
            ? 'Nothing remembered yet. Members save facts about the project as they work, or add one above.'
            : `Nothing remembered yet. ${owner} saves facts as you work together, or add one above.`)}
        </Text>
      ) : (
        <Surface style={{ overflow: 'hidden' }}>
          {items.map((m, i) => (
            <Animated.View key={m.key} entering={FadeIn.duration(motion.duration.fast)} exiting={FadeOut.duration(motion.duration.quick)} layout={LinearTransition.duration(motion.duration.fast)}>
              {i > 0 && <Divider inset={16} />}
              <MemoryRow m={m} onDelete={() => remove(m)} />
            </Animated.View>
          ))}
        </Surface>
      )}
    </View>
  )
}

function MemoryRow({ m, onDelete }: { m: Memory; onDelete: () => void }) {
  const { c } = useTheme()
  // Only right actions exist, so any full swipe open means delete.
  return (
    <Swipeable
      friction={1.6}
      rightThreshold={48}
      overshootRight={false}
      onSwipeableOpen={() => { haptic.warning(); onDelete() }}
      renderRightActions={() => (
        <View style={{ width: 88, backgroundColor: c.danger, alignItems: 'center', justifyContent: 'center' }}>
          <Icon icon={Delete02Icon} size={20} color="#ffffff" />
        </View>
      )}
    >
      <Press
        radius={0}
        static
        wash={c.wash}
        onLongPress={() => showMenu({ title: 'Memory', message: m.text, items: [{ label: 'Delete fact', icon: Delete02Icon, destructive: true, onPress: onDelete }] })}
        accessibilityLabel={m.text}
        accessibilityHint="Long-press to delete"
        accessibilityActions={[{ name: 'delete', label: 'Delete fact' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') onDelete() }}
        style={{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.panel }}
      >
        <Text variant="body">{m.text}</Text>
      </Press>
    </Swipeable>
  )
}
