import {
  ConfigPlugin,
  withAndroidManifest,
  withEntitlementsPlist,
  withGradleProperties,
  AndroidConfig,
} from "@expo/config-plugins"
import { ExpoConfig } from "@expo/config-types"

type Options = {
  /**
   * Enable `android:largeHeap="true"` on the <application> element in AndroidManifest.xml.
   *
   * On most modern devices this raises the Java heap ceiling from the standard
   * 128–256 MB tier up to 512 MB or more, giving the app room to breathe before
   * the system throws an OutOfMemoryError.
   *
   * @default true
   */
  androidLargeHeap?: boolean

  /**
   * Maximum JVM heap size passed to Gradle via `org.gradle.jvmargs=-Xmx<N>m` in
   * `android/gradle.properties`. Increase this if Gradle itself runs out of memory
   * during the build (distinct from the app's runtime heap set by `androidLargeHeap`).
   *
   * @default 4096 (4 GB)
   */
  gradleJvmHeapMB?: number

  /**
   * Add the `com.apple.developer.kernel.increased-memory-limit` entitlement for iOS.
   *
   * On supported devices running iOS 15+ this allows the app to exceed the default
   * per-process memory limit imposed by the OS. Unlike Android's fixed heap ceiling,
   * iOS OOM kills are driven by overall system pressure; this entitlement signals to
   * the kernel that the process may legitimately hold a larger footprint.
   *
   * Prerequisites:
   *  - Paid Apple Developer account
   *  - The capability must be enabled on your App ID at developer.apple.com
   *    (Identifiers → select your App ID → Additional Capabilities → Increased Memory Limit)
   *
   * @default true
   */
  iosIncreasedMemoryLimit?: boolean
}

/**
 * Sets `org.gradle.jvmargs=-Xmx<N>m` in `android/gradle.properties` so the
 * Gradle daemon has enough heap to handle large dependency graphs and resource
 * processing without running out of memory during the build.
 *
 * TODO: revisit once largeHeap is validated in the field. This is build-time only and
 * does nothing for the runtime OOM the rest of this plugin targets, and the Kotlin
 * daemon inherits `-Xmx`/`MaxMetaspaceSize` when `kotlin.daemon.jvmargs` is unset, so
 * 4096 puts two daemons at ~9.2 GB of a 16 GB medium EAS worker. 2048 was working.
 */
const withGradleJvmHeap: ConfigPlugin<Options> = (config, { gradleJvmHeapMB = 4096 } = {}) => {
  return withGradleProperties(config, (modConfig) => {
    // Remove any existing org.gradle.jvmargs entry so we don't duplicate it.
    modConfig.modResults = modConfig.modResults.filter(
      (prop) => !(prop.type === "property" && prop.key === "org.gradle.jvmargs"),
    )
    modConfig.modResults.push({
      type: "property",
      key: "org.gradle.jvmargs",
      value: `-Xmx${gradleJvmHeapMB}m -XX:MaxMetaspaceSize=512m`,
    })
    return modConfig
  })
}

/**
 * Modifies `android/app/src/main/AndroidManifest.xml` to set
 * `android:largeHeap="true"` on the `<application>` element.
 */
const withAndroidLargeHeap: ConfigPlugin<Options> = (config, { androidLargeHeap = true } = {}) => {
  if (!androidLargeHeap) return config

  return withAndroidManifest(config, (modConfig) => {
    const app = AndroidConfig.Manifest.getMainApplication(modConfig.modResults)
    if (app) {
      app.$["android:largeHeap"] = "true"
    }
    return modConfig
  })
}

/**
 * Adds `com.apple.developer.kernel.increased-memory-limit = true` to the
 * app's `.entitlements` file.
 */
const withIosIncreasedMemoryLimit: ConfigPlugin<Options> = (
  config,
  { iosIncreasedMemoryLimit = true } = {},
) => {
  if (!iosIncreasedMemoryLimit) return config

  return withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults["com.apple.developer.kernel.increased-memory-limit"] = true
    return modConfig
  })
}

/**
 * Expo Config Plugin — `withLargeHeap`
 *
 * Expands the memory available to the app on Android and iOS to prevent
 * crashes caused by large working-memory footprints.
 *
 * Android
 * -------
 * Sets `android:largeHeap="true"` in AndroidManifest.xml. The Android runtime
 * then allocates heap from a higher tier (often 512 MB+ on modern devices)
 * rather than the standard 128–256 MB bucket.
 *
 * iOS
 * ---
 * Adds the `com.apple.developer.kernel.increased-memory-limit` entitlement.
 * iOS does not expose a configurable heap ceiling the way Android does; instead,
 * the kernel enforces a per-process limit that varies by device. This entitlement
 * tells the kernel the process is allowed a larger footprint before it is killed
 * under memory pressure.
 *
 * Register this last in the plugins array: it overwrites any org.gradle.jvmargs set earlier.
 *
 * Usage in app.config.ts
 * ----------------------
 * ```ts
 * plugins: [
 *   require("./plugins/withLargeHeap").withLargeHeap,
 *   // — or with options —
 *   [require("./plugins/withLargeHeap").withLargeHeap, { androidLargeHeap: true, iosIncreasedMemoryLimit: true }],
 * ]
 * ```
 */
export const withLargeHeap: ConfigPlugin<Options | void> = (config, options) => {
  const opts: Options = (options as Options | undefined) ?? {}
  config = withGradleJvmHeap(config as ExpoConfig, opts)
  config = withAndroidLargeHeap(config as ExpoConfig, opts)
  config = withIosIncreasedMemoryLimit(config as ExpoConfig, opts)
  return config
}
