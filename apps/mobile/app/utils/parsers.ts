import Language from "@/models/Language"
import { Collection, Model, Q } from "@nozbe/watermelondb"

/**
Method standardizes object and string metadata and returns the expected type T

@param {string | Object} metadata
@returns {{result: T | string, error: Error | null}}
*/
export function parseMetadata<T>(
  metadata: string | object,
): { result: string; error: Error } | { result: T; error: null } {
  if (typeof metadata === "object") {
    return {
      result: metadata as T, // cast the metadata into the expected type for easy type inference
      error: null,
    }
  }
  try {
    const result = JSON.parse(metadata)
    return {
      result,
      error: null,
    }
  } catch (e) {
    return {
      result: metadata,
      error: e as Error,
    }
  }
}

/**
Given a translation object and a language key to, return that language label, or default to the english version.
If the english version does not exist, return any.

@param {TranslationObject} translations
@param {string} language
@return {string} translation
*/
export function getTranslation(translations: Language.TranslationObject, language: string): string {
  const translationKeys = Object.keys(translations)

  // in the case of no translations, return an empty string
  if (translationKeys.length === 0) {
    return ""
  }
  if (Object.hasOwn(translations, language)) {
    return translations[language]
  } else if (Object.hasOwn(translations, "en") || Object.hasOwn(translations, "en-US")) {
    return translations.en
  } else {
    return translations[translationKeys[0]]
  }
}

// /*
// Normalize Arabic text to remove extra characters and spaces
// */
// export function normalizeArabic(text: string): string {
//   return text
//     .replace(/[يى]/g, "ی")
//     .replace(/[أإآا]/g, "ا")
//     .replace(/ة/g, "ه")
//     .replace(/ئ/g, "ی")
//     .replace(/ؤ/g, "و")
//     .replace(/[ءٔ]/g, "")
//     .replace(/\s+/g, " ")
//     .trim()
// }

// /**
//  * Sanitize a string to be used in a LIKE query
//  * @param value - The string to sanitize
//  * @returns The sanitized string
//  */
// const safeLikeCharsRegexp = /[^\p{L}\p{N}]/gu

// export function extendedSanitizeLikeString(value: string): string {
//   invariant(typeof value === "string", "Value passed to Q.sanitizeLikeString() is not a string")
//   return value.replace(safeLikeCharsRegexp, "_")
// }

// export default function invariant(condition: any, errorMessage?: string): void {
//   if (!condition) {
//     const error: any = new Error(errorMessage || "Broken invariant")
//     error.framesToPop = 1
//     throw error
//   }
// }

// Arabic letters that our normalization collapses many variants into. In the
// prefilter these become `_` so a single stored codepoint of ANY variant matches.
const AMBIGUOUS_LETTERS = new Set(["ا", "ه", "و", "ی"])

const ARABIC_RANGE = /[\u0600-\u06FF]/
const WORD_CHAR = /[\p{L}\p{N}]/u
const TATWEEL = /\u0640/g
const COMBINING_MARK = /\p{Mn}/gu // Latin accents AND Arabic harakat (tashkeel)
const WHITESPACE_RUN = /\s+/g

/**
 * Canonical form used on BOTH the query and each stored candidate. Must be
 * identical on both sides or phase 2 silently drops real matches.
 *
 * ASCII-safe: NFD + strip combining marks folds `café`→`cafe`, `CAFÉ`→`cafe`,
 * and Arabic harakat, in one pass. Then map Arabic letter variants to a single
 * canonical letter and lowercase for English.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .replace(TATWEEL, "") // tatweel is not a mark, needs its own strip
    .replace(/[يى]/g, "ی")
    .replace(/ة/g, "ه")
    .replace(/ئ/g, "ی")
    .replace(/ؤ/g, "و")
    .replace(/ء/g, "")
    .replace(/[أإآا]/g, "ا") // most alef forms already folded by NFD; kept for safety
    .replace(WHITESPACE_RUN, " ")
    .toLowerCase()
    .trim()
}

/**
 * Build a loose `LIKE` pattern for ONE already-normalized token (no spaces).
 *
 * - ambiguous Arabic letters -> `_` (matches any stored variant codepoint)
 * - other Arabic letters     -> preceded by `%` to absorb stored diacritics
 * - latin/digits             -> kept contiguous within a run (`%cat%`, not `%c%a%t%`)
 * - non-word chars           -> dropped, breaking contiguity
 *
 * Injection-safe by construction: only letters/digits are emitted literally, so
 * a user's own `%`/`_` never reach the query. No sanitizeLikeString needed here.
 */
export function buildPrefilter(token: string): string {
  let pattern = ""
  let previousWasWord = false
  for (const character of token) {
    if (!WORD_CHAR.test(character)) {
      previousWasWord = false
      continue
    }
    const emitted = AMBIGUOUS_LETTERS.has(character) ? "_" : character
    if (ARABIC_RANGE.test(character)) {
      pattern += "%" + emitted // `%` also absorbs stray NFD marks between letters
    } else {
      pattern += (previousWasWord ? "" : "%") + emitted
    }
    previousWasWord = true
  }
  // trailing `%` absorbs a stored combining mark on the final letter (NFD input)
  return (pattern || "%") + "%"
}

/**
 * Split a raw query into normalized search tokens, dropping any token with no
 * letter/digit. Filtering these out matters: a punctuation-only token would
 * otherwise `buildPrefilter` to a bare `%%`, which `LIKE`-matches every row.
 */
export function tokenizeForSearch(rawQuery: string): string[] {
  return normalizeForSearch(rawQuery)
    .split(" ")
    .filter((token) => WORD_CHAR.test(token))
}

/** True if every char of `needle` appears in `haystack`, in order (gaps allowed). */
function lettersInOrder(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true
  let matched = 0
  for (const character of haystack) {
    if (character === needle[matched]) matched += 1
    if (matched === needle.length) return true
  }
  return false
}

/**
 * Score one token against a candidate. Higher is a tighter match.
 * `words` = normalized haystack split on spaces; `hayFlat` = spaces removed
 * (space-insensitive, so `عبدالله` matches stored `عبد الله` and vice versa).
 * Returns -1 when the token is absent → candidate is a phase-1 false positive.
 */
function scoreToken(words: string[], hayFlat: string, token: string): number {
  if (words.includes(token)) return 4 // exact whole-word component
  if (words.some((word) => word.startsWith(token))) return 3 // word prefix
  if (hayFlat.includes(token)) return 2 // substring anywhere, ignoring spaces
  return lettersInOrder(hayFlat, token) ? 1 : -1
}

// WatermelonDB models expose columns via camelCase getters, not their raw
// snake_case names — read the raw stored value by DB column name so the search
// (given real column names) works against actual model instances.
function readField(record: Model, column: string): string {
  const value = record._getRaw(column)
  return typeof value === "string" ? value : ""
}

interface ScoredRecord<T extends Model> {
  record: T
  exactFull: number // 1 if the whole query equals the whole (spaceless) field
  total: number
  length: number
}

/**
 * Tokenized, order-independent, cross-column ranked search.
 *
 * Every token must match at least one column (AND across tokens, OR across
 * columns), so words may live in different fields and appear in any order.
 * Results are sorted best-first: exact full record, then summed token score,
 * then shortest field (tightest match) as the final tiebreaker.
 *
 * @param collection  the WatermelonDB collection to search
 * @param columns     real DB column names holding searchable text
 * @param rawQuery    the user's raw search string
 */
export async function searchRanked<T extends Model>(
  collection: Collection<T>,
  columns: string[],
  rawQuery: string,
): Promise<T[]> {
  const tokens = tokenizeForSearch(rawQuery)
  if (tokens.length === 0) return []
  if (columns.length === 0) return []

  // Phase 1: each token must appear in some column (leading `%` => full scan,
  // no index; fine on-device at moderate row counts, measure if tables grow).
  const clause = Q.and(
    ...tokens.map((token) => {
      const pattern = buildPrefilter(token)
      return Q.or(...columns.map((column) => Q.where(column, Q.like(pattern))))
    }),
  )
  const candidates = await collection.query(clause).fetch()

  return rankByRelevance(candidates, columns, rawQuery)
}

/**
 * Phase 2 on its own: reject candidates that do not really contain every token,
 * then rank — exact full match, then summed token score, then shortest field.
 *
 * Split out of `searchRanked` for callers that must build their own phase-1
 * query, like the patient list with its permission and attribute clauses.
 *
 * @param candidates  rows that already passed a phase-1 prefilter
 * @param columns     real DB column names holding searchable text
 * @param minTokenScore  lowest per-token score to keep (see `scoreToken`)
 */
export function rankByRelevance<T extends Model>(
  candidates: readonly T[],
  columns: string[],
  rawQuery: string,
  { minTokenScore = 1 }: { minTokenScore?: number } = {},
): T[] {
  const tokens = tokenizeForSearch(rawQuery)
  if (tokens.length === 0) return []
  if (columns.length === 0) return []

  const queryFlat = tokens.join("")

  const scored: ScoredRecord<T>[] = []
  for (const record of candidates) {
    const haystack = columns
      .map((column) => normalizeForSearch(readField(record, column)))
      .join(" ")
    const words = haystack.split(" ").filter(Boolean)
    const hayFlat = haystack.replace(/ /g, "")

    const tokenScores = tokens.map((token) => scoreToken(words, hayFlat, token))
    // 1 keeps `lettersInOrder` subsequence hits — the typo tolerance the
    // duplicate-patient search wants. 2 demands a real substring, or "علي"
    // matches "عبدالله المصري" by scattered letters.
    if (tokenScores.some((score) => score < minTokenScore)) continue

    scored.push({
      record,
      exactFull: hayFlat === queryFlat ? 1 : 0,
      total: tokenScores.reduce((sum, score) => sum + score, 0),
      length: hayFlat.length,
    })
  }

  scored.sort(
    (a, b) =>
      b.exactFull - a.exactFull || // exact full match first
      b.total - a.total || //         then best token scores
      a.length - b.length, //         then tightest (shortest) field
  )
  return scored.map((entry) => entry.record)
}

/**
 * Safely stringifies an object or returns the input if it's already a string.
 * If input is a string that appears to be JSON, it will be parsed and re-stringified.
 *
 * @param {unknown} input - The input to stringify or return
 * @param {string} defaultValue - The default value to return if stringification fails
 * @returns {string} The stringified object or the default value
 */
/** Separator for joining multiple checkbox selections into a single string (ASCII Unit Separator) */
export const CHECKBOX_SEPARATOR = "\x1F"

export const joinCheckboxValues = (values: string[]): string => values.join(CHECKBOX_SEPARATOR)

export const splitCheckboxValues = (raw: string | null | undefined): string[] =>
  raw ? raw.split(CHECKBOX_SEPARATOR).filter(Boolean) : []

/**
 * Separator for joining an event-form multi-select's chosen option values
 * into the single string the dropdown widget persists. Kept here as the one
 * source of truth so the storage site (the picker's `setValue`) and the
 * read sites (`multiPickerValue`, `EventForm.buildRuleScope`) can't drift on
 * the delimiter.
 */
export const EVENT_MULTI_SEPARATOR = "; "

export const joinMultiValues = (values: string[]): string => values.join(EVENT_MULTI_SEPARATOR)

export const splitMultiValues = (raw: string | null | undefined): string[] =>
  raw ? raw.split(EVENT_MULTI_SEPARATOR).filter(Boolean) : []

export function safeStringify(input: unknown, defaultValue: string): string {
  if (input === undefined || input === null || input === "") {
    return defaultValue
  }

  if (typeof input === "string") {
    try {
      // If the string is already valid JSON, parse and re-stringify to normalize it
      const parsed = JSON.parse(input)
      return JSON.stringify(parsed)
    } catch {
      // Not valid JSON — stringify the string itself so it becomes valid JSON (e.g. "hello" → '"hello"')
      return JSON.stringify(input)
    }
  }

  try {
    return JSON.stringify(input)
  } catch {
    return defaultValue
  }
}
