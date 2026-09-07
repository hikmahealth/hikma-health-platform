// Note the syntax of these imports from the date-fns library.
// If you import with the syntax: import { format } from "date-fns" the ENTIRE library
// will be included in your production bundle (even if you only use one function).
// This is because react-native does not support tree-shaking.
import { format } from "date-fns/format"
import type { Locale } from "date-fns/locale"
import { parseISO } from "date-fns/parseISO"
import Language from "../core/language"

type Options = Parameters<typeof format>[2]

let dateFnsLocale: Locale

export const loadDateFnsLocale = (primaryTag: string) => {
  switch (primaryTag) {
    case "en":
      dateFnsLocale = require("date-fns/locale/en-US").default
      break
    case "ar":
      dateFnsLocale = require("date-fns/locale/ar").default
      break
    case "ko":
      dateFnsLocale = require("date-fns/locale/ko").default
      break
    case "es":
      dateFnsLocale = require("date-fns/locale/es").default
      break
    case "fr":
      dateFnsLocale = require("date-fns/locale/fr").default
      break
    case "hi":
      dateFnsLocale = require("date-fns/locale/hi").default
      break
    case "ja":
      dateFnsLocale = require("date-fns/locale/ja").default
      break
    default:
      dateFnsLocale = require("date-fns/locale/en-US").default
      break
  }
}

/**
 * Undefined before loadDateFnsLocale has run. date-fns reads that as en-US, so
 * callers can pass the result straight through without a null check.
 */
export const getDateFnsLocale = (): Locale | undefined => dateFnsLocale

export const formatDate = (date: string, dateFormat?: string, options?: Options) => {
  const dateOptions = {
    ...options,
    locale: getDateFnsLocale(),
  }
  return format(parseISO(date), dateFormat ?? "MMM dd, yyyy", dateOptions)
}
