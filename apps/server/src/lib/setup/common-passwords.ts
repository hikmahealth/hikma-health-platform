// Server only: the list is ~460 KB.
// Source: SecLists (MIT) @ 10a38f6cbe8ed6b89d55348756eff7486cd0f0ea,
// Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt, filtered to
// PASSWORD_LENGTH_MIN+ characters. Its sha256 is pinned in the password-policy test.
import list from "./common-passwords.txt?raw";
import { type PasswordCheck, checkPasswordLength } from "./password-policy";

let commonPasswords: ReadonlySet<string> | null = null;

const loadCommonPasswords = (): ReadonlySet<string> => {
  commonPasswords ??= new Set(
    list
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.toLowerCase()),
  );
  return commonPasswords;
};

/** Whether the password appears on the common-password list, ignoring case. */
export const isCommonPassword = (password: string): boolean =>
  loadCommonPasswords().has(password.toLowerCase());

/** The full password rule for new accounts: the length rule plus the common list. */
export const checkPassword = (password: string): PasswordCheck => {
  const length = checkPasswordLength(password);
  if (!length.ok) return length;
  if (isCommonPassword(password)) {
    return {
      ok: false,
      reason: "This password is too common. Choose one that is harder to guess",
    };
  }
  return { ok: true };
};
