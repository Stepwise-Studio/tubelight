import { useEffect, useId, useSyncExternalStore, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

// A tiny portal: overlays (sheets, dialogs, menus) render in one host above navigation,
// so gestures and the keyboard behave the same as in any screen. No RN Modal involved.
let nodes: [string, ReactNode][] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function setPortal(key: string, node: ReactNode | null) {
  const i = nodes.findIndex(([k]) => k === key)
  if (node == null) { if (i >= 0) nodes = nodes.filter(([k]) => k !== key) }
  else if (i >= 0) nodes = nodes.map((e) => (e[0] === key ? [key, node] : e))
  else nodes = [...nodes, [key, node]]
  emit()
}

/** Renders its children in the PortalHost. */
export function Portal({ children }: { children: ReactNode }) {
  const key = useId()
  useEffect(() => { setPortal(key, children) })
  useEffect(() => () => setPortal(key, null), [key])
  return null
}

/** Mount once near the root, inside the theme provider. */
export function PortalHost() {
  const list = useSyncExternalStore(subscribe, () => nodes, () => nodes)
  if (!list.length) return null
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {list.map(([k, n]) => <View key={k} style={StyleSheet.absoluteFill} pointerEvents="box-none">{n}</View>)}
    </View>
  )
}
