namespace Language {
  export type Locale = keyof typeof LOCALE_MAP

  export const RTL_LANGUAGES: Locale[] = [
    "ar", // arabic
    "arc", // aramaic
    "az", // azeri
    "dv", // dhevei
    "he", // hebrew
    "ku", // kurdish
    "fa", // farsi / persion
    "ur", // urdu
  ]

  export type DefaultLanguages = "en" | "es" | "ar"

  export const LOCALE_MAP = {
    "en": "en",
    "ar": "ar",
    "es": "es",
    "en-US": "en-US",
    "ko": "ko",
    "fr": "fr",
    "sw": "sw",
    "cn": "cn",
    "jp": "jp",
    "ru": "ru",
    "de": "de",
    "it": "it",
    "pt": "pt",
    "hi": "hi",
    "ur": "ur",
    "fa": "fa",
    "ku": "ku",
    "he": "he",
    "dv": "dv",
    "az": "az",
    "arc": "arc",
  } as const
}

export default Language
