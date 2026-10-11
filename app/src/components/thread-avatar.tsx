import { View } from 'react-native'
import {
  AirplaneTakeOff01Icon, Book02Icon, Briefcase01Icon, Bug01Icon, Calendar03Icon, ChartLineData01Icon, CodeIcon, Coffee01Icon,
  FavouriteIcon, Globe02Icon, Home01Icon, Idea01Icon, Megaphone01Icon, MusicNote01Icon, PaintBoardIcon, Plant02Icon, Rocket01Icon,
  ShoppingBag01Icon, StarIcon, UserGroupIcon,
} from '@hugeicons/core-free-icons'

import { useWorkspace } from '@/lib/workspace'
import { useTheme } from '@/theme'
import { Icon, Squircle, TeammateAvatar } from '@/ui'

/** A group chat's picture: one of these on the project colour (until hand-drawn emblems replace them). */
export const GROUP_ICONS = {
  group: UserGroupIcon, rocket: Rocket01Icon, idea: Idea01Icon, code: CodeIcon, bug: Bug01Icon, design: PaintBoardIcon,
  launch: Megaphone01Icon, chart: ChartLineData01Icon, work: Briefcase01Icon, calendar: Calendar03Icon, book: Book02Icon, coffee: Coffee01Icon,
  plant: Plant02Icon, home: Home01Icon, travel: AirplaneTakeOff01Icon, globe: Globe02Icon, shop: ShoppingBag01Icon, music: MusicNote01Icon,
  heart: FavouriteIcon, star: StarIcon,
} as const
export type GroupIcon = keyof typeof GROUP_ICONS

/** The group picture by itself (also the tiles in the icon picker). Squircle = group, circle = person. */
export function GroupAvatar({ color, icon, size = 48, working = false }: { color: string; icon: string | null; size?: number; working?: boolean }) {
  const { c } = useTheme()
  return (
    <View style={{ width: size, height: size }}>
      <Squircle style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: color || c.panel2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.imageOutline }}>
        <Icon icon={GROUP_ICONS[icon as GroupIcon] ?? GROUP_ICONS.group} size={Math.round(size * 0.46)} color="#18181b" strokeWidth={1.75} />
      </Squircle>
      {working && <View pointerEvents="none" style={{ position: 'absolute', inset: -3, borderRadius: size * 0.36, borderWidth: 2, borderColor: c.tube }} />}
    </View>
  )
}

/** A DM shows the teammate's face; a project shows its icon on its colour. */
export function ThreadAvatar({ threadId, size = 48, interactive = false }: { threadId: string; size?: number; interactive?: boolean }) {
  const ws = useWorkspace()
  const people = ws.threadTeammates(threadId)
  if (threadId.startsWith('dm:')) {
    const t = people[0]
    if (!t) return <View style={{ width: size, height: size }} />
    return <TeammateAvatar teammate={t} size={size} interactive={interactive} state={ws.isWorking(t.id) ? 'working' : 'default'} />
  }
  const p = ws.projects.find((x) => `proj:${x.id}` === threadId)
  return <GroupAvatar color={p?.color ?? ''} icon={p?.icon ?? null} size={size} working={people.some((t) => ws.isWorking(t.id))} />
}
