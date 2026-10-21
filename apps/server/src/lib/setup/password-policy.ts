export const PASSWORD_LENGTH_MIN = 8;

/** bcrypt silently ignores everything past its first 72 bytes. */
export const PASSWORD_BYTES_MAX = 72;

export type PasswordCheck = { ok: true } | { ok: false; reason: string };

/**
 * Length rules, safe to run in the browser. The minimum counts characters, not
 * UTF-16 units; the maximum counts UTF-8 bytes, which is what bcrypt sees.
 */
export const checkPasswordLength = (password: string): PasswordCheck => {
  if ([...password].length < PASSWORD_LENGTH_MIN) {
    return {
      ok: false,
      reason: `Password must be at least ${PASSWORD_LENGTH_MIN} characters`,
    };
  }
  if (new TextEncoder().encode(password).length > PASSWORD_BYTES_MAX) {
    return {
      ok: false,
      reason: `Password is too long. Use at most ${PASSWORD_BYTES_MAX} characters, fewer if it has accents or emoji`,
    };
  }
  return { ok: true };
};
