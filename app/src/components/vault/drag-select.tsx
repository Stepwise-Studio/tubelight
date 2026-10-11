// Choosing several by dragging, as Android's gallery does: hold a file until it's chosen, then slide over others
// without lifting; everything between where you started and your finger is chosen (and unchosen if you slide back).
// Near the list's top or bottom edge it scrolls. Shared by the vault, Google Drive and the phone's files.
//
// A Pan that may only start after a hold follows the finger. The list (gesture handler's FlatList) waits for that
// Pan to fail before scrolling: a finger that moves before the hold fails it at once, so scrolling stays instant,
// while after a hold the drag owns the touch. A hold without moving is the file's own long-press (begin).
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native'
import { Gesture, type GestureType } from 'react-native-gesture-handler'

import { haptic } from '@/ui'

const HOLD_MS = 350 // a file's own long-press is 500: moving after this starts the drag
const EDGE = 90
const SPEED = 14

interface Props {
  /** The item under `x` in the list's cell `index` (a row of tiles or one row), or null. */
  keyAt: (index: number, x: number) => string | null
  /** Every choosable item, in the order shown. */
  order: string[]
  selected: Set<string>
  setSelected: (f: (s: Set<string>) => Set<string>) => void
}
type Scroller = { scrollToOffset: (o: { offset: number; animated?: boolean }) => void }

/** The drag's state lives outside React (it changes every frame); the hook hands it the latest props. */
function controller() {
  const cells = new Map<number, { y: number; h: number }>()
  const st = { scrollY: 0, height: 0, props: null as Props | null }
  const pan: { current: GestureType | undefined } = { current: undefined }
  let list: Scroller | null = null
  let drag: { anchor: number; base: Set<string>; last: number; x: number; y: number; live: boolean; timer?: ReturnType<typeof setInterval> } | null = null

  const hit = (x: number, y: number) => {
    const at = y + st.scrollY
    for (const [index, c] of cells) if (at >= c.y && at < c.y + c.h) return st.props!.keyAt(index, x)
    return null
  }
  const extend = () => {
    if (!drag || !st.props) return
    const key = hit(drag.x, drag.y)
    const i = key ? st.props.order.indexOf(key) : -1
    if (i < 0 || i === drag.last) return
    drag.last = i
    const [a, b] = drag.anchor < i ? [drag.anchor, i] : [i, drag.anchor]
    const chosen = new Set([...drag.base, ...st.props.order.slice(a, b + 1)])
    st.props.setSelected(() => chosen)
    haptic.tap()
  }
  const edge = (y: number) => (!st.height ? 0 : y < EDGE ? -1 : y > st.height - EDGE ? 1 : 0)
  const stop = () => {
    if (!drag) return
    if (drag.timer) clearInterval(drag.timer)
    drag = null
  }

  /** A file was held: choose it and follow the finger from here. */
  const begin = (key: string) => {
    const p = st.props
    const anchor = p ? p.order.indexOf(key) : -1
    if (!p || anchor < 0) return
    stop() // a leftover from a touch that never ended cleanly
    drag = { anchor, base: new Set(p.selected), last: anchor, x: -1, y: -1, live: false }
    const chosen = new Set([...drag.base, key])
    p.setSelected(() => chosen)
    haptic.light()
  }
  const follow = (x: number, y: number) => {
    if (!drag) return
    drag.live = true // the finger is moving under the Pan (auto-scroll only then)
    drag.x = x
    drag.y = y
    extend()
    if (edge(y) && !drag.timer) {
      drag.timer = setInterval(() => {
        if (!drag) return
        const dir = drag.live ? edge(drag.y) : 0
        if (!dir) { clearInterval(drag.timer); drag.timer = undefined; return }
        st.scrollY = Math.max(0, st.scrollY + dir * SPEED)
        list?.scrollToOffset({ offset: st.scrollY, animated: false })
        extend()
      }, 16)
    }
  }

  const gesture = Gesture.Pan().activateAfterLongPress(HOLD_MS).withRef(pan).runOnJS(true)
    .onStart((e) => {
      const key = st.props ? hit(e.x, e.y) : null
      if (key && (!drag || st.props!.order[drag.anchor] !== key)) begin(key) // moved right after the hold, before the file's own long-press
      follow(e.x, e.y)
    })
    .onUpdate((e) => follow(e.x, e.y))
    .onEnd(stop)
    .onTouchesUp(stop)
    .onTouchesCancelled(stop)
    .onFinalize(stop)

  // Every cell reports where it sits in the list, for finding what's under the finger.
  function Cell({ index, style, onLayout, children }: { index: number; style?: StyleProp<ViewStyle>; onLayout?: (e: LayoutChangeEvent) => void; children?: ReactNode }) {
    return (
      <View style={style} onLayout={(e) => { cells.set(index, { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height }); onLayout?.(e) }}>
        {children}
      </View>
    )
  }

  return {
    setProps: (p: Props) => { st.props = p },
    begin,
    gesture,
    wrapProps: { style: { flex: 1 }, collapsable: false, onLayout: (e: LayoutChangeEvent) => { st.height = e.nativeEvent.layout.height } },
    listProps: {
      ref: (r: Scroller | null) => { list = r },
      waitFor: pan,
      CellRendererComponent: Cell,
      onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { st.scrollY = e.nativeEvent.contentOffset.y },
      scrollEventThrottle: 16,
    },
  }
}

export function useDragSelect(props: Props) {
  const [ctl] = useState(controller)
  useLayoutEffect(() => { ctl.setProps(props) })
  return {
    /** Call from a file's long-press. */
    begin: ctl.begin,
    /** For a GestureDetector around the list. */
    gesture: ctl.gesture,
    /** Spread onto a View between the GestureDetector and the list (it measures the list's height). */
    wrapProps: ctl.wrapProps,
    /** Spread onto the list (gesture handler's FlatList). */
    listProps: ctl.listProps,
  }
}
