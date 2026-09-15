/**
 * Shared credential sign-in, used by both `/api/auth/sign-in` (web) and
 * `/api/login` (the endpoint the mobile app calls).
 *
 * `/api/login` used to reach `/api/auth/sign-in` over the network with
 * `fetch(new Request(url, request))`. A Request built from another Request has
 * no rewindable body source, so the moment anything answered that self-fetch
 * with a 3xx, undici could not replay the body and returned a bare network
 * error — surfacing as `TypeError: fetch failed` and an unhandled 500. Both
 * routes call this function directly instead; there is no self-request to
 * redirect.
 *
 * The rate limiters live here rather than in either route so the two entry
 * points share one bucket. Splitting them would hand an attacker a second,
 * independent budget for the same credentials.
 */

import { setCookie } from "@tanstack/react-start/server";
import { minutesToMilliseconds } from "date-fns";
import { Logger } from "@hikmahealth/js-utils";
import User from "@/models/user";
import Clinic from "@/models/clinic";
import {
  createRateLimiter,
  emailAccountKey,
  getClientIp,
} from "@/lib/rate-limiter";

/** Per email per IP, so a site sharing one router can still log everyone in. */
const perAccountLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(15),
  maxRequests: 10,
});

/** Per-IP backstop against guessing across many emails from one address. */
const perIpLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(15),
  maxRequests: 300,
});

/** The signed-in user as returned to clients — never the real password hash. */
export type SignedInUser = User.EncodedT & {
  clinic_name: string | undefined;
};

export type SignInOutcome =
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "invalid" }
  | { kind: "ok"; user: SignedInUser; token: string };

/**
 * Rate-limit, verify credentials, and set the session cookie.
 *
 * Callers map the outcome onto whatever response shape their endpoint owes its
 * clients — the two differ, which is the only reason this returns a union
 * rather than a `Response`.
 */
export async function attemptSignIn(request: Request): Promise<SignInOutcome> {
  const ip = getClientIp(request);
  const byIp = perIpLimiter.check(`ip:${ip}`);
  if (!byIp.allowed) {
    return { kind: "rate-limited", retryAfterMs: byIp.retryAfterMs };
  }

  const { email, password } = await request.json();

  const account =
    typeof email === "string" && email.length > 0
      ? emailAccountKey(email)
      : "anonymous";
  const byAccount = perAccountLimiter.check(`${ip}|${account}`);
  if (!byAccount.allowed) {
    return { kind: "rate-limited", retryAfterMs: byAccount.retryAfterMs };
  }

  try {
    const { user, token } = await User.signIn(email, password);

    const clinic = user.clinic_id ? await Clinic.getById(user.clinic_id) : null;

    setCookie("token", token, {
      httpOnly: true,
      secure: import.meta.env.DEV ? false : true,
      // "lax" (not "strict") so the cookie is sent on top-level navigations
      // into the app (refresh, bookmarks, external links). Under "strict" the
      // SSR auth guard sees no token on these loads and bounces the user to
      // the login screen.
      sameSite: "lax",
      path: "/",
      expires: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    return {
      kind: "ok",
      user: {
        ...user,
        hashed_password: "************",
        clinic_name: clinic?.name,
      },
      token,
    };
  } catch (error) {
    Logger.error({ msg: "[sign-in error]", error });
    // Deliberately uniform: callers must not be able to tell "no such user"
    // from "wrong password".
    return { kind: "invalid" };
  }
}
