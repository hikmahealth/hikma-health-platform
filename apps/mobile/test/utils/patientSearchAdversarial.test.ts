/**
 * Adversarial tests for the patient-search path behind `PatientsListScreen`.
 *
 * The helpers in `app/utils/parsers.ts` are unit-tested; the composition in
 * `useOfflinePatients` is not. The hook cannot be imported here — it pulls in
 * `@/db`, and any jest file that does never exits in-band — so the two query
 * shapes are mirrored below and run against a faithful LIKE matcher.
 *
 * `it.failing` marks a confirmed defect: it flips to a suite failure once fixed.
 */

import fc from "fast-check"
import { Q } from "@nozbe/watermelondb"

import {
  buildPrefilter,
  normalizeForSearch,
  tokenizeForSearch,
  searchRanked,
  rankByRelevance,
} from "../../app/utils/parsers"

/**
 * SQLite `LIKE` semantics, which is what runs in production.
 *
 * DO NOT replace this with a WatermelonDB-backed test. LokiJS routes `Q.like`
 * through `likeToRegexp`, whose `i` flag folds the whole Unicode range while
 * SQLite folds ASCII only — so Loki calls `'CAFÉ' LIKE '%café%'` a match where
 * a device does not, exactly the class of bug this file exists to catch.
 *
 * `%` -> any run, `_` -> exactly one character, everything else literal.
 */
const foldAsciiCase = (value: string): string => value.replace(/[A-Z]/g, (c) => c.toLowerCase())
const escapeRegExp = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function sqliteLike(pattern: string, value: string): boolean {
  const source = [...foldAsciiCase(pattern)]
    .map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : escapeRegExp(ch)))
    .join("")
  // `u` so `.` consumes one code point, matching SQLite's UTF-8-aware `_`.
  return new RegExp(`^${source}$`, "su").test(foldAsciiCase(value))
}

/** The pattern the name search actually issues, per useDataProviderPatients.ts:241-245. */
const namePattern = (query: string): string[] =>
  tokenizeForSearch(query).map((token) => buildPrefilter(token))

/** Display page size, and the candidate budget the hook over-fetches to. */
const PAGE = 30
const BUDGET = 500

/**
 * Phase 1 as the list screen issues it: AND across tokens, OR across the two
 * name columns. The SQL prefilter only — deliberately loose, and not what is shown.
 */
const listScreenMatches = (
  query: string,
  record: { given_name: string; surname: string },
): boolean =>
  namePattern(query).every(
    (pattern) => sqliteLike(pattern, record.given_name) || sqliteLike(pattern, record.surname),
  )

/** A candidate row shaped like the WatermelonDB model `rankByRelevance` reads. */
const asModel = (record: { given_name: string; surname: string }) =>
  ({ ...record, _getRaw: (column: string) => (record as any)[column] ?? null }) as any

/**
 * The whole pipeline: phase-1 prefilter capped at the candidate budget, then
 * `rankByRelevance`, then slice to the page. Mirrors `useOfflinePatients`.
 */
const listScreenDisplay = (
  query: string,
  population: Array<{ given_name: string; surname: string }>,
) => {
  const candidates = population.filter((row) => listScreenMatches(query, row)).slice(0, BUDGET)
  return rankByRelevance(candidates.map(asModel), ["given_name", "surname"], query, {
    minTokenScore: 2,
  }).slice(0, PAGE)
}

// A realistic corpus. Arabic given names are dense in alef/heh/waw/yeh, which is
// exactly the set `buildPrefilter` collapses to `_`.
const GIVEN_NAMES = [
  "محمد",
  "احمد",
  "علي",
  "عبدالله",
  "فاطمة",
  "اسماء",
  "زينب",
  "حسين",
  "مريم",
  "سارة",
  "خالد",
  "نور",
  "هالة",
  "ياسمين",
  "عمر",
  "ليلى",
  "ابراهيم",
  "رنا",
  "سامي",
  "هدى",
]
const SURNAMES = [
  "الحسيني",
  "العلي",
  "المصري",
  "السوري",
  "الاحمد",
  "الخالدي",
  "النجار",
  "الحلبي",
  "السالم",
  "العمري",
]
const CORPUS = GIVEN_NAMES.flatMap((given) =>
  SURNAMES.map((surname) => ({ given_name: given, surname })),
)

describe("the prefilter still finds the patient it is meant to find", () => {
  it("matches an Arabic name against its own stored spelling", () => {
    for (const name of GIVEN_NAMES) {
      expect(sqliteLike(buildPrefilter(normalizeForSearch(name)), name)).toBe(true)
    }
  })

  it("matches across harakat, tatweel and letter-variant spellings", () => {
    // stored with diacritics / tatweel / a different yeh+teh-marbuta variant
    const stored = ["مُحَمَّد", "محـــمد", "فاطمه", "علی"]
    const queries = ["محمد", "محمد", "فاطمة", "علي"]
    stored.forEach((storedName, index) => {
      expect(sqliteLike(buildPrefilter(normalizeForSearch(queries[index])), storedName)).toBe(true)
    })
  })

  it("matches any ASCII name against itself regardless of case", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z]{2,12}$/), (name) => {
        expect(sqliteLike(buildPrefilter(normalizeForSearch(name)), name)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe("the prefilter is far looser than the name being searched", () => {
  // `%` between every Arabic letter turns the pattern into a subsequence match,
  // and ambiguous letters become `_`, which matches ANY single character.

  it.failing("does not return a different patient for a common given name", () => {
    // "علي" (Ali) -> %ع%ل%_% , which "عبدالله" (Abdullah) satisfies.
    expect(sqliteLike(buildPrefilter(normalizeForSearch("علي")), "عبدالله")).toBe(false)
  })

  it.failing("does not confuse two of the most common names in the corpus", () => {
    // "احمد" (Ahmad) -> %_%ح%م%د% , which "محمد" (Muhammad) satisfies.
    expect(sqliteLike(buildPrefilter(normalizeForSearch("احمد")), "محمد")).toBe(false)
  })

  it.failing("does not degrade to a match-all pattern for an ordinary name", () => {
    // "هالة" (Hala): every letter but ل is ambiguous -> %_%_%ل%_%
    const pattern = buildPrefilter(normalizeForSearch("هالة"))
    const hits = CORPUS.filter((row) => sqliteLike(pattern, `${row.given_name} ${row.surname}`))
    expect(hits.length).toBeLessThan(CORPUS.length)
  })

  it.failing("the SQL prefilter keeps precision within 2x of the intended set", () => {
    // Still true of phase 1: ~38.7 rows per single-token query against 10
    // intended. Parked — tightening it needs a normalized column, i.e. a
    // migration. What the user sees is filtered by phase 2, see below.
    for (const query of GIVEN_NAMES) {
      const hits = CORPUS.filter((row) => listScreenMatches(query, row))
      const intended = CORPUS.filter((row) => row.given_name === query)
      expect(hits.length).toBeLessThanOrEqual(intended.length * 2)
    }
  })

  it("but every row actually displayed really contains the query", () => {
    // Phase 2 closes the gap. The invariant is containment somewhere in the
    // name, not given_name equality: "احمد" legitimately matches "الاحمد".
    for (const query of GIVEN_NAMES) {
      const token = normalizeForSearch(query)
      for (const row of listScreenDisplay(query, CORPUS)) {
        const haystack = normalizeForSearch(`${row.given_name} ${row.surname}`).replace(/ /g, "")
        expect(haystack).toContain(token)
      }
    }
  })
})

describe("the searched-for patient can be absent from the results", () => {
  it("keeps the intended patient inside the first page, worst-case ordering", () => {
    // "هالة" prefilters to a match-all pattern, and the intended patients are
    // the least recently updated — the case Q.take used to push off the page.
    const query = "هالة"
    const byRecency = [
      ...CORPUS.filter((row) => row.given_name !== query),
      ...CORPUS.filter((row) => row.given_name === query),
    ]
    const page = listScreenDisplay(query, byRecency)
    expect(page.length).toBeGreaterThan(0)
    expect(page.every((row) => row.given_name === query)).toBe(true)
  })
})

describe("Latin names with accents", () => {
  // normalizeForSearch strips combining marks from the QUERY, but nothing
  // normalizes the stored columns, so phase 1 folds one side only.

  it.failing("finds a stored accented name by its accented spelling", () => {
    expect(sqliteLike(buildPrefilter(normalizeForSearch("café")), "café")).toBe(true)
  })

  it.failing("finds a stored accented name by its unaccented spelling", () => {
    for (const [query, stored] of [
      ["cafe", "café"],
      ["muller", "müller"],
      ["jose", "José"],
      ["renee", "Renée"],
    ]) {
      expect(sqliteLike(buildPrefilter(normalizeForSearch(query)), stored)).toBe(true)
    }
  })
})

describe("the expanded-search call site", () => {
  // fieldLikeClause hands a whole field value to buildPrefilter and the caller
  // only gates on `.trim().length > 0`, so a punctuation-only value becomes a
  // bare "%%" — narrowing the search silently returns an unfiltered list.
  const fieldPattern = (value: string) => buildPrefilter(normalizeForSearch(value))

  it.failing("never produces a match-all pattern for a value the caller accepts", () => {
    for (const value of ["...", "!!!", "---", "??", "،،"]) {
      expect(value.trim().length).toBeGreaterThan(0) // the caller's gate lets it through
      expect(fieldPattern(value)).not.toBe("%%")
    }
  })
})

describe("select-field filters", () => {
  // fieldLikeClause anchors select values with Q.sanitizeLikeString, whose
  // regex is /[^a-zA-Z0-9]/g -> "_", so every non-ASCII character becomes a
  // wildcard. It replaced the repo's Unicode-aware extendedSanitizeLikeString.
  const selectPattern = (value: string) => `${Q.sanitizeLikeString(value)}%`

  it("anchors an ASCII select value so male never matches female", () => {
    expect(sqliteLike(selectPattern("male"), "female")).toBe(false)
    expect(sqliteLike(selectPattern("male"), "male")).toBe(true)
  })

  it.failing("anchors an Arabic select value just as tightly", () => {
    // "ذكر" (male) -> "___%" , which matches any value of 3+ characters.
    expect(sqliteLike(selectPattern("ذكر"), "انثى")).toBe(false)
  })

  it.failing("keeps at least one literal character from a non-ASCII select value", () => {
    for (const value of ["ذكر", "انثى", "غير محدد"]) {
      expect(Q.sanitizeLikeString(value)).toMatch(/[\p{L}\p{N}]/u)
    }
  })
})

describe("searchRanked's phase 2 is exactly what the list screen omits", () => {
  /**
   * Runs phase 1 against the SQLite-faithful matcher, then hands the survivors
   * to the production `searchRanked` so its phase-2 scoring runs unmodified.
   */
  function collectionFor(rows: Array<{ given_name: string; surname: string }>, columns: string[]) {
    return {
      query: () => ({
        fetch: async () =>
          rows.map((fields) => ({ _getRaw: (c: string) => (fields as any)[c] ?? null })),
      }),
      __phase1: (query: string) =>
        rows.filter((row) =>
          tokenizeForSearch(query).every((token) =>
            columns.some((column) => sqliteLike(buildPrefilter(token), (row as any)[column])),
          ),
        ),
    } as any
  }

  const COLUMNS = ["given_name", "surname"]

  it("rejects the phase-1 false positives the list screen would render", async () => {
    const collection = collectionFor(CORPUS, COLUMNS)
    const candidates = collection.__phase1("علي")
    // Phase 1 alone is already imprecise...
    expect(candidates.length).toBeGreaterThan(10)
    // ...and phase 2 removes every row that does not really contain the token.
    const ranked = await searchRanked(collectionFor(candidates, COLUMNS), COLUMNS, "علي")
    expect(ranked.length).toBeLessThan(candidates.length)
  })

  it("ANDs its tokens, so a second word can only narrow the result", async () => {
    const collection = collectionFor(CORPUS, COLUMNS)
    const one = await searchRanked(collection, COLUMNS, "علي")
    const two = await searchRanked(collection, COLUMNS, "علي العلي")
    expect(two.length).toBeLessThanOrEqual(one.length)
  })

  it("the list screen's clause also narrows when a word is added", () => {
    // Regression guard. While the tokens were ORed, typing more of the name
    // returned MORE rows: "محمد" -> 10, "محمد العلي" -> 29, against 1 intended.
    const one = CORPUS.filter((row) => listScreenMatches("محمد", row))
    const two = CORPUS.filter((row) => listScreenMatches("محمد العلي", row))
    expect(two.length).toBeLessThanOrEqual(one.length)
  })

  it("still matches across a space boundary at the raised score floor", () => {
    // minTokenScore: 2 demands a contiguous substring of the space-flattened
    // haystack — what `scoreToken` exists for: a query written solid must still
    // find a name stored with a space, and vice versa.
    const solid = [{ given_name: "عبدالله", surname: "الحسيني" }]
    const spaced = [{ given_name: "عبد الله", surname: "الحسيني" }]
    expect(listScreenDisplay("عبدالله", spaced)).toHaveLength(1)
    expect(listScreenDisplay("عبد الله", solid)).toHaveLength(1)
  })

  it("narrows all the way to the one intended patient once a surname is typed", () => {
    const page = listScreenDisplay("محمد العلي", CORPUS)
    expect(page).toHaveLength(1)
    expect(page[0].given_name).toBe("محمد")
    expect(page[0].surname).toBe("العلي")
  })
})
