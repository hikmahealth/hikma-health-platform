import { describe, expect, it } from "vitest";
import {
  pageCount,
  pageOffset,
  pageWindow,
} from "@/lib/server-functions/builders";

describe("pageOffset", () => {
  it("maps 1-based pages onto 0-based offsets", () => {
    expect(pageOffset(1, 25)).toBe(0);
    expect(pageOffset(2, 25)).toBe(25);
    expect(pageOffset(4, 10)).toBe(30);
  });

  it("never returns a negative offset for an out-of-range page", () => {
    expect(pageOffset(0, 25)).toBe(0);
    expect(pageOffset(-3, 25)).toBe(0);
  });

  it("floors a fractional page rather than producing a fractional offset", () => {
    expect(pageOffset(2.9, 10)).toBe(10);
  });

  it("falls back to the first page for non-finite input", () => {
    expect(pageOffset(Number.NaN, 25)).toBe(0);
    expect(pageOffset(Number.POSITIVE_INFINITY, 25)).toBe(0);
  });
});

describe("pageCount", () => {
  it("reports one page when there is nothing to show", () => {
    expect(pageCount(0, 25)).toBe(1);
  });

  it("does not open an empty trailing page on an exact multiple", () => {
    expect(pageCount(50, 25)).toBe(2);
  });

  it("rounds a partial page up", () => {
    expect(pageCount(51, 25)).toBe(3);
    expect(pageCount(1, 25)).toBe(1);
  });

  it("stays at one page for a nonsensical page size", () => {
    expect(pageCount(100, 0)).toBe(1);
  });
});

describe("pageWindow", () => {
  it("lists every page when they all fit in the window", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it("collapses to a single entry for a lone page", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
  });

  it("keeps the first and last page alongside the current neighbourhood", () => {
    expect(pageWindow(5, 10)).toEqual([1, 4, 5, 6, 10]);
  });

  it("leaves a gap the caller can draw an ellipsis into", () => {
    const shown = pageWindow(7, 20);
    expect(shown).toEqual([1, 6, 7, 8, 20]);
    expect(shown[1] - shown[0]).toBeGreaterThan(1);
  });

  it("never repeats a page when the current page abuts an end", () => {
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 5]);
    expect(pageWindow(5, 5)).toEqual([1, 4, 5]);
  });

  it("returns ascending, unique page numbers for every page of a range", () => {
    for (let page = 1; page <= 12; page++) {
      const shown = pageWindow(page, 12);
      expect(new Set(shown).size).toBe(shown.length);
      expect([...shown].sort((a, b) => a - b)).toEqual(shown);
      expect(shown.at(0)).toBe(1);
      expect(shown.at(-1)).toBe(12);
    }
  });
});
