/**
 * Human-in-the-loop prompt timeouts — single source of truth.
 *
 * Previously four call sites each hard-coded their own value (10m credential
 * request, 15m OAuth wizard, 5m credential choice, 5m approval), which made the
 * UX inconsistent and the numbers hard to find. They are unified here.
 *
 * One default covers every interactive prompt where the user is filling in or
 * approving something. OAuth keeps a longer window because locating a
 * client id/secret in a provider console legitimately takes longer than
 * approving a single call or picking between saved credentials.
 */

/** Default wait for any HITL prompt: credential entry, approval, credential choice. */
export const HITL_TIMEOUT_MS = 10 * 60_000;

/** OAuth setup wizard — longer, since the user may be hunting for app credentials. */
export const HITL_OAUTH_TIMEOUT_MS = 15 * 60_000;
