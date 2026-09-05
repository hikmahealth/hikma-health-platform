/**
 * A subscription supplying only `error:` still crashes the app on a row that
 * fails to decode: RxJS sends a throw from `next` down its unhandled path.
 */

import { Observable } from "rxjs"

import { observerWithFallback } from "@/db/observerWithFallback"

describe("observerWithFallback", () => {
  it("passes emissions through untouched", () => {
    const seen: number[] = []
    const onFailure = jest.fn()

    const observer = observerWithFallback((value: number) => seen.push(value), onFailure)
    observer.next(1)
    observer.next(2)

    expect(seen).toEqual([1, 2])
    expect(onFailure).not.toHaveBeenCalled()
  })

  it("routes a throw from the emission handler to the fallback", () => {
    const boom = new Error("malformed row")
    const onFailure = jest.fn()

    const observer = observerWithFallback(() => {
      throw boom
    }, onFailure)

    expect(() => observer.next(undefined)).not.toThrow()
    expect(onFailure).toHaveBeenCalledWith(boom)
  })

  it("routes an observable error to the fallback", () => {
    const boom = new Error("query failed")
    const onFailure = jest.fn()

    new Observable((subscriber) => subscriber.error(boom)).subscribe(
      observerWithFallback(() => {}, onFailure),
    )

    expect(onFailure).toHaveBeenCalledWith(boom)
  })

  it("keeps the subscription alive after a failed emission", () => {
    const seen: number[] = []
    const onFailure = jest.fn()

    new Observable<number>((subscriber) => {
      subscriber.next(1)
      subscriber.next(2)
      subscriber.next(3)
    }).subscribe(
      observerWithFallback((value: number) => {
        if (value === 2) throw new Error("malformed row")
        seen.push(value)
      }, onFailure),
    )

    expect(seen).toEqual([1, 3])
    expect(onFailure).toHaveBeenCalledTimes(1)
  })
})
