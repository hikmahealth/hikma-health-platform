/**
 * Escapes a value for interpolation into HTML text or a quoted attribute.
 * Absent values render empty rather than as "null" or "undefined".
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}
