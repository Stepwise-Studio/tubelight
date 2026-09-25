import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'

import { type Palette, useTheme } from '@/theme'

export type { IconSvgElement }

export interface IconProps {
  icon: IconSvgElement
  /** 18 in rows, 20 in buttons, 24 in tab bars. */
  size?: number
  color?: keyof Palette | (string & {})
  /** 1.5 beside regular text, 2 beside semibold. */
  strokeWidth?: number
}

/** Hugeicons, the one icon set. Decorative: name the control that holds it, not the icon. */
export function Icon({ icon, size = 20, color = 'ink2', strokeWidth = 1.5 }: IconProps) {
  const { c } = useTheme()
  const resolved = (c as Record<string, string>)[color] ?? color
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      color={resolved}
      strokeWidth={strokeWidth}
    />
  )
}
