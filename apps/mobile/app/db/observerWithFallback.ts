/**
 * A subscription observer that routes every failure to `onFailure`.
 *
 * An `error:` callback alone misses a throw from inside `next`: RxJS reports
 * that through its unhandled-error path, which on React Native reaches the
 * global handler rather than the ErrorBoundary, so one row that fails to decode
 * takes the app down instead of the screen.
 *
 * A failing query is not among the failures this catches. Watermelon's
 * observation paths `logError` and return without emitting, so a query that
 * cannot run leaves the subscription silent rather than erroring it.
 */
export const observerWithFallback = <T>(
  onNext: (value: T) => void,
  onFailure: (error: unknown) => void,
) => ({
  next: (value: T) => {
    try {
      onNext(value)
    } catch (error) {
      onFailure(error)
    }
  },
  error: onFailure,
})
