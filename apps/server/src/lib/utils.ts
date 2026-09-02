import { Logger } from "@hikmahealth/js-utils";
import { clsx, type ClassValue } from "clsx";
import {
  differenceInDays,
  differenceInMonths,
  differenceInYears,
} from "date-fns";
import toLower from "lodash/toLower";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A *civil date* is a calendar date with no timezone — a date of birth, not an
 * instant — carried as "YYYY-MM-DD" with no offset ever applied.
 *
 * A `Date` holding one can be in either of two *frames*, same type but opposite
 * correct treatment:
 *
 *   - **Local calendar parts** — `new Date(y, m, d)`, how `pg` parses a
 *     Postgres `date` column and how a browser date picker builds its value.
 *     Local getters invert it.
 *   - **A UTC instant** — arrived over JSON from `toISOString()`. UTC getters
 *     invert it.
 *
 * The wrong one shifts the day anywhere off UTC, so pick by frame rather than
 * merging these into a single helper.
 */
const civilDateParts = (
  value: Date,
  frame: "local" | "utc",
): string | null => {
  if (Number.isNaN(value.getTime())) return null;
  const [y, m, d] =
    frame === "local"
      ? [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      : [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
  return [y, String(m).padStart(2, "0"), String(d).padStart(2, "0")].join("-");
};

const asCivilDateString = (
  value: Date | string | null | undefined,
  frame: "local" | "utc",
): string | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    // An ISO instant in string form came from a toISOString() somewhere, so
    // read it back in UTC regardless of the caller's frame.
    const parsed = new Date(trimmed);
    return civilDateParts(parsed, "utc");
  }

  return civilDateParts(value, frame);
};

/**
 * Civil date out of a `Date` built from **local calendar parts** — parsed by
 * `pg` from a `date` column, or picked in a browser date input.
 */
export function civilDateFromLocalDate(
  value: Date | string | null | undefined,
): string | null {
  return asCivilDateString(value, "local");
}

/**
 * Civil date out of a **UTC instant** — a `Date` or ISO string that reached us
 * over JSON. A "YYYY-MM-DD" string passes through.
 *
 * Only recovers the intended day when the sender did not already lose it: a
 * client sending `new Date(y, m, d).toISOString()` has destroyed it east of UTC
 * before we see it, which is why the registration form sends "YYYY-MM-DD".
 */
export function civilDateFromInstant(
  value: Date | string | null | undefined,
): string | null {
  return asCivilDateString(value, "utc");
}

/**
 * Parse a civil date for *display*: "YYYY-MM-DD" becomes a `Date` at **local**
 * midnight, so formatting it prints the day that was stored. `new Date(str)`
 * would yield UTC midnight and print the previous day west of UTC.
 *
 * A `Date` passes through; any other string falls back to normal parsing.
 * Returns null when there is nothing usable to show.
 */
export function parseCivilDate(
  value: Date | string | null | undefined,
): Date | null {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (matched) {
    const [, year, month, day] = matched.map(Number);
    const date = new Date(year, month - 1, day);
    // Reject overflow such as "2024-13-45", which the Date constructor would
    // silently roll forward into a different month.
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return date;
  }

  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
Utility function that processes the values of an object

@param {Object} obj
@oaram {(v: any) => any} func
@returns {Object}
*/
export function mapObjectValues<T>(obj: T, func: (v: any) => any): T {
  return Object.fromEntries(
    Object.entries(obj as any).map(([k, v]) => [k, func(v)]),
  ) as T;
}

/**
 * Recursively converts all user-defined keys in an object to camelCase
 * @param obj The object to convert
 * @returns A new object with all user-defined keys in camelCase
 */
export const camelCaseKeys = <T extends Record<string, any>>(obj: T): T => {
  if (typeof obj !== "object" || obj === null) return obj;
  try {
    // prevent circular references
    JSON.parse(JSON.stringify(obj));
  } catch (e) {
    Logger.error(e);
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(camelCaseKeys) as unknown as T;
  }

  return Object.entries(obj).reduce(
    (acc: Record<string, any>, [key, value]) => {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const camelKey = key.replace(/([-_][a-z])/gi, ($1) =>
          $1.toUpperCase().replace("-", "").replace("_", ""),
        );
        acc[camelKey] = camelCaseKeys(value);
      }
      return acc;
    },
    {},
  ) as T;
};

/**
 * Deduplicates an array of options based on their `value` field.
 *
 * @param {Array<{ label: string, value: string }>} options - The array of options to deduplicate.
 * @returns {Array<{ label: string, value: string }>} The deduplicated array of options.
 */
export function deduplicateOptions(
  options: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  const seenValues = new Set<string>();
  const deduplicatedOptions: Array<{ label: string; value: string }> = [];

  for (const option of options.filter((o) => o)) {
    if (!seenValues.has(option.value)) {
      seenValues.add(option.value);
      deduplicatedOptions.push(option);
    }
  }

  return deduplicatedOptions;
}

/**
 * Reorders a list of strings based on a second list that specifies the desired order.
 *
 * @param list1 The list of strings to be reordered.
 * @param list2 The list of strings specifying the desired order.
 *              Can include "_" as a placeholder to skip a position.
 *              Strings not present in `list1` are ignored.
 *
 * @returns A new array with the strings from `list1` reordered according to `list2`.
 */
export function orderedList(list1: string[], list2: string[]): string[] {
  if (!Array.isArray(list1)) {
    return [];
  }
  if (!Array.isArray(list2) && Array.isArray(list1)) {
    return list1;
  }
  const result: string[] = [];
  const remaining = list1.filter((item) => item);
  const countMap = new Map<string, number>();

  remaining.forEach((item) => {
    countMap.set(item, (countMap.get(item) || 0) + 1);
  });

  for (const item of list2) {
    if (item === "_") {
      continue; // Skip the "_" placeholder
    }
    if (countMap.has(item)) {
      result.push(item);
      const count = countMap.get(item)!;
      if (count > 1) {
        countMap.set(item, count - 1);
      } else {
        countMap.delete(item);
      }
    }
  }

  // Add any remaining items from list1 in their original order
  remaining.forEach((item) => {
    if (countMap.has(item)) {
      result.push(item);
      const count = countMap.get(item)!;
      if (count > 1) {
        countMap.set(item, count - 1);
      } else {
        countMap.delete(item);
      }
    }
  });

  return result;
}

/**
 * Safely parses a JSON string or returns the input if it's already of the expected type.
 * If parsing fails or the input doesn't match the expected type, it returns the provided default value.
 *
 * @template T The expected type of the parsed object
 * @param {unknown} input The input to parse or return
 * @param {T} defaultValue The default value to return if parsing fails or type doesn't match
 * @returns {T} The parsed object, the input if it's already of type T, or the default value
 */
export function safeJSONParse<T>(input: unknown, defaultValue: T): T {
  if (input === undefined || input === null) {
    return defaultValue;
  }
  if (
    typeof input === typeof defaultValue &&
    (Array.isArray(input) ? Array.isArray(defaultValue) : true)
  ) {
    return input as T;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return typeof parsed === typeof defaultValue ? parsed : defaultValue;
    } catch (error) {
      return defaultValue;
    }
  }

  return defaultValue;
}

/**
 * Safely stringifies an object or returns the input if it's already a string.
 * If input is a string that appears to be JSON, it will be parsed and re-stringified.
 *
 * @param {unknown} input - The input to stringify or return
 * @param {string} defaultValue - The default value to return if stringification fails
 * @returns {string} The stringified object or the default value
 */
export function safeStringify(input: unknown, defaultValue: string): string {
  if (input === undefined || input === null) {
    return defaultValue;
  }

  if (typeof input === "string") {
    try {
      // Check if the string is valid JSON by attempting to parse it
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed);
    } catch (error) {
      // If it's not valid JSON, return the original string
      return input;
    }
  }

  try {
    return JSON.stringify(input);
  } catch (error) {
    return defaultValue;
  }
}

/**
 * Attempts to parse a date from various input types.
 * @param {unknown} input - The input to parse as a date. Can be a Date object, string, or number.
 * @param {Date} [defaultDate] - An optional default date to return if parsing fails.
 * @returns {Date} The parsed date or the default date.
 * @throws {Error} If parsing fails and no valid default date is provided.
 */
export const tryParseDate = (input: unknown, defaultDate?: Date): Date => {
  if (input instanceof Date && !isNaN(input.getTime())) {
    return input;
  }

  if (typeof input === "string" || typeof input === "number") {
    const parsedDate = new Date(input);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate;
    }
  }

  if (defaultDate instanceof Date && !isNaN(defaultDate.getTime())) {
    return defaultDate;
  }

  throw new Error("Invalid date input and no valid default date provided");
};

/**
 * Safely converts various date formats to ISO string for database insertion
 * @param {any} value - The date value to convert
 * @returns {string} - ISO string or default value if invalid/empty
 */
export function toSafeDateString(
  value: any,
  defaultValue = new Date().toISOString(),
): string {
  if (
    value == null ||
    value === "" ||
    value === "null" ||
    value === "undefined"
  ) {
    return defaultValue;
  }

  try {
    let date: Date;

    // Handle numeric values (assume milliseconds if > 1e12, seconds otherwise)
    if (
      typeof value === "number" ||
      (typeof value === "string" && /^-?\d+$/.test(value.trim()))
    ) {
      const num = typeof value === "number" ? value : parseInt(value, 10);
      // Negative values are pre-1970 dates (e.g. birthdays) — always in ms.
      // Positive: >1e12 means ms, otherwise seconds.
      const ms = num < 0 ? num : num > 1e12 ? num : num * 1000;
      date = new Date(ms);
    } else {
      date = new Date(value);
    }

    if (isNaN(date.getTime())) return defaultValue;

    const year = date.getFullYear();
    if (year < 1850 || year > 2120) return defaultValue;

    return date.toISOString();
  } catch {
    return defaultValue;
  }
}

/**
 * Returns a truncated object containing the top N key-value pairs sorted by value,
 * with an "other" key summing the remaining values.
 *
 * @param {Record<string, number>} obj - The input object to be truncated.
 * @param {number} topN - The number of top entries to keep.
 * @returns {Record<string, number>} A new object with the top N entries and an "other" key.
 */
export function getTopNWithOther(
  obj: Record<string, number>,
  topN: number,
): Record<string, number> {
  const sortedEntries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const topEntries = sortedEntries.slice(0, topN);
  const otherSum = sortedEntries
    .slice(topN)
    .reduce((sum, [, value]) => sum + value, 0);

  const result: Record<string, number> = Object.fromEntries(topEntries);
  if (otherSum > 0) {
    result.other = (result.other ?? 0) + otherSum;
  }

  return result;
}

/**
 * Converts a list of strings to an array of field options with label and value properties.
 * The label is the original string and value is the lowercase version of the string.
 *
 * @param {string[]} list - The array of strings to convert to field options
 * @returns {Array<{label: string, value: string}>} An array of field option objects
 */
export function listToFieldOptions(
  list: string[],
): { label: string; value: string }[] {
  return list.map((item) => ({
    label: item,
    value: toLower(item),
  }));
}

// Return the union of two field options arrays
export function fieldOptionsUnion(
  options1: { label: string; value: string }[],
  options2: { label: string; value: string }[],
): { label: string; value: string }[] {
  const options1Map = options1.reduce(
    (acc, option) => ({ ...acc, [option.value]: option }),
    {},
  );
  const options2Map = options2.reduce(
    (acc, option) => ({ ...acc, [option.value]: option }),
    {},
  );

  return Object.values({ ...options1Map, ...options2Map });
}

// getFieldOptionsValues
export function getFieldOptionsValues(
  options: { label: string; value: string }[],
): string[] {
  return options.map((option) => option.value);
}

/**
 * Checks if a string is a valid UUID. Checks for uuid v1 to v8
 * @param {string} str - The string to check
 * @returns {boolean} True if the string is a valid UUID, false otherwise
 */
export function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    str,
  );
}

/**
 * Calculate similarity between two strings
 * CREDIT && Reference: https://github.com/stephenjjbrown/string-similarity-js/blob/master/src/string-similarity.ts
 * @param {string} str1 First string to match
 * @param {string} str2 Second string to match
 * @param {number} [substringLength=2] Optional. Length of substring to be used in calculating similarity. Default 2.
 * @param {boolean} [caseSensitive=false] Optional. Whether you want to consider case in string matching. Default false;
 * @returns Number between 0 and 1, with 0 being a low match score.
 */
export const stringSimilarity = (
  str1: string,
  str2: string,
  substringLength: number = 2,
  caseSensitive: boolean = false,
) => {
  if (!caseSensitive) {
    str1 = str1.toLowerCase();
    str2 = str2.toLowerCase();
  }

  if (str1.length < substringLength || str2.length < substringLength) return 0;

  const map = new Map();
  for (let i = 0; i < str1.length - (substringLength - 1); i++) {
    const substr1 = str1.substr(i, substringLength);
    map.set(substr1, map.has(substr1) ? map.get(substr1) + 1 : 1);
  }

  let match = 0;
  for (let j = 0; j < str2.length - (substringLength - 1); j++) {
    const substr2 = str2.substr(j, substringLength);
    const count = map.has(substr2) ? map.get(substr2) : 0;
    if (count > 0) {
      map.set(substr2, count - 1);
      match++;
    }
  }

  return (match * 2) / (str1.length + str2.length - (substringLength - 1) * 2);
};

/**
 * Given a list of strings, return the strings that appear more than once.
 * @param {string[]} strings List of strings to check for duplicates.
 * @returns {string[]} List of strings that appear more than once.
 */
export const findDuplicatesStrings = (strings: string[]): string[] => {
  const counts = new Map();
  for (const str of strings) {
    counts.set(str, (counts.get(str) || 0) + 1);
  }
  return Array.from(counts)
    .filter(([_, count]) => count > 1)
    .map(([str]) => str);
};

/**
 * Calculates the age from a date of birth.
 * @param dateOfBirth The date of birth.
 * @returns The age.
 */
export function calculateAge(
  dateOfBirth: Date | string | number | null,
): string {
  if (!dateOfBirth) return "";

  let dob: Date;

  if (dateOfBirth instanceof Date) {
    dob = dateOfBirth;
  } else if (typeof dateOfBirth === "number") {
    dob = new Date(dateOfBirth);
  } else if (typeof dateOfBirth === "string") {
    // A DOB is a civil date; parsed as UTC midnight it would be compared
    // against a local `now`, putting the age boundary a day out.
    const parsed = parseCivilDate(dateOfBirth);
    if (parsed === null) return "";
    dob = parsed;
  } else {
    return "";
  }

  if (isNaN(dob.getTime())) {
    return "";
  }

  const now = new Date();
  const years = differenceInYears(now, dob);
  const months = differenceInMonths(now, dob) % 12;
  const days = differenceInDays(now, dob) % 30; // Approximation, not exact

  let ageString = "";
  if (years > 0) ageString += `${years} year${years !== 1 ? "s" : ""}`;
  if (months > 0)
    ageString += `${ageString ? ", " : ""}${months} month${months !== 1 ? "s" : ""}`;
  if (days > 0 || ageString === "")
    ageString += `${ageString ? " and " : ""}${days} day${days !== 1 ? "s" : ""}`;

  return ageString;
}

/**
 * Separator used for joining multiple checkbox values into a single string.
 *
 * Uses the ASCII Unit Separator (U+001F) instead of a printable sequence like ";;".
 * A printable separator is ambiguous when user-supplied values contain the same
 * characters — e.g. a value of ";" joined with ";;" produces ";;; " which
 * splits incorrectly. U+001F is a single non-printable control character that
 * browsers strip from form input, so it can never appear in real user values,
 * guaranteeing lossless join/split round-trips.
 */
export const CHECKBOX_SEPARATOR = "\x1F";

/**
 * Join an array of selected checkbox values into a single string using the custom separator.
 */
export function joinCheckboxValues(values: string[]): string {
  return values.join(CHECKBOX_SEPARATOR);
}

/**
 * Split a stored checkbox string back into an array of values.
 */
export function splitCheckboxValues(value: string): string[] {
  if (!value) return [];
  return value.split(CHECKBOX_SEPARATOR).filter(Boolean);
}

/**
 * Counts the number of lines in a multiline string.
 *
 * @param text - The input string to count lines in
 * @returns The number of lines (empty string returns 0)
 *
 * @example
 * countLines('hello\nworld\n'); // 2
 * countLines('single line');    // 1
 * countLines('');               // 0
 */
export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/**
 * Render a drug strength for display.
 *
 * `drug_catalogue.dosage_quantity` is `decimal(10, 4)` and arrives from `pg` as
 * a string. Rounding it to a fixed width turns 0.0125 mg into 0.01 mg, so
 * trailing zeros are trimmed rather than digits dropped. An absent strength
 * renders as "" — a blank is honest where a fabricated "0.00" is not.
 */
export function formatDrugStrength(
  value: number | string | null | undefined,
): string {
  // Number("") and Number("  ") are both 0 — the fabricated zero this guards.
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  return String(parsed);
}
