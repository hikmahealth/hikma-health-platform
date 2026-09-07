import { StyleProp } from "react-native"
import { colors as colorsLight } from "./colors"
import { spacing as spacingLight } from "./spacing"
import { timing } from "./timing"
import { typography } from "./typography"
import { z } from "zod"
// This supports "light" and "dark" themes by default. If undefined, it'll use the system theme
export type ImmutableThemeContextModeT = "light" | "dark"
export type ThemeContextModeT = ImmutableThemeContextModeT | undefined

// Because we have two themes, we need to define the types for each of them.
// colorsLight and colorsDark should have the same keys, but different values.
export type Colors = typeof colorsLight // | typeof colorsDark
// The spacing type needs to take into account the different spacing values for light and dark themes.
export type Spacing = typeof spacingLight // | typeof spacingDark

// These two are consistent across themes.
export type Timing = typeof timing
export type Typography = typeof typography

export const schema = z.object({
  colors: z.record(z.string(), z.any()),
  spacing: z.record(z.string(), z.any()),
  typography: z.record(z.string(), z.any()),
  timing: z.any(),
  is_dark: z.boolean(),
})

// The overall Theme object should contain all of the data you need to style your app.
export type Theme = z.output<typeof schema>

/**
 * Represents a function that returns a styled component based on the provided theme.
 * @template T The type of the style.
 * @param theme The theme object.
 * @returns The styled component.
 *
 * @example
 * const $container: ThemedStyle<ViewStyle> = (theme) => ({
 *   flex: 1,
 *   backgroundColor: theme.colors.background,
 *   justifyContent: "center",
 *   alignItems: "center",
 * })
 * // Then use in a component like so:
 * const Component = () => {
 *   const { themed } = useAppTheme()
 *   return <View style={themed($container)} />
 * }
 */
export type ThemedStyle<T> = (theme: Theme) => T
export type ThemedStyleArray<T> = (
  ThemedStyle<T> | StyleProp<T> | (StyleProp<T> | ThemedStyle<T>)[]
)[]

/**
 */
export type AllowedStylesT<T> = ThemedStyle<T> | StyleProp<T> | ThemedStyleArray<T>
/**
 */
export type ThemedFnT = <T>(styleOrStyleFn: AllowedStylesT<T>) => T

// Here we define our themes.
export const LIGHT_THEME: Theme = {
  colors: colorsLight,
  spacing: spacingLight,
  typography,
  timing,
  is_dark: false,
}
