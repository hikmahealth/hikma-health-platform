/** Web login lowercases the email and sign-in matches exactly, so store it that way. */
export const normaliseEmail = (email: string): string =>
  email.trim().toLowerCase();

export const normaliseName = (name: string): string => name.trim();

/** An unchanged email is kept as stored: devices re-send it before every sync. */
export const emailForUpdate = (
  submitted: string,
  stored: string | undefined,
): string => (submitted === stored ? submitted : normaliseEmail(submitted));
