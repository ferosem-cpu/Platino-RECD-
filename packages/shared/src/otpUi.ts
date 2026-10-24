/**
 * Pure helpers for the OTP screens (web and mobile) so the wording and the resend countdown behave the same
 * everywhere and can be unit tested. The server is the authority: these only present what it answered.
 */

/** "10 minutes", "5 minutes", "1 minute", "45 seconds". */
export function otpExpiryText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a few minutes";
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Label for the resend control: counts down while the cooldown runs. */
export function resendLabel(secondsLeft: number): string {
  return secondsLeft > 0 ? `Resend code in ${Math.ceil(secondsLeft)}s` : "Resend code";
}

export function canResend(secondsLeft: number, busy = false): boolean {
  return secondsLeft <= 0 && !busy;
}

/** One tick of the countdown (never below zero). */
export function tickCooldown(secondsLeft: number): number {
  return Math.max(0, Math.ceil(secondsLeft) - 1);
}

/** What the server told us when a code was requested. */
export interface OtpRequestResult {
  message?: string;
  expiresInSeconds?: number;
  resendAfterSeconds?: number;
}

/** The notice shown after a request the server accepted. It never claims a phone received anything. */
export function otpRequestedNotice(result: OtpRequestResult, fallbackExpirySeconds: number): string {
  const expiry = otpExpiryText(result.expiresInSeconds ?? fallbackExpirySeconds);
  return `${result.message ?? "If those details match an account, a code has been sent to its registered mobile number."} The code is valid for ${expiry}.`;
}

export interface OtpErrorInfo {
  status?: number;
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * Turns a failed OTP request/verify into the sentence the user sees:
 * rate limit, waiting before resend, delivery failure, or an invalid/expired code.
 */
export function otpErrorText(kind: "request" | "verify", info: OtpErrorInfo): string {
  if (info.status === 429) {
    const wait = info.retryAfterSeconds && info.retryAfterSeconds > 0 ? ` Try again in ${otpExpiryText(info.retryAfterSeconds)}.` : "";
    if (info.message && /wait/i.test(info.message)) return info.message;
    return `Too many attempts.${wait}`;
  }
  if (info.status === 503) {
    return info.message || "We could not send the code right now. Please try again in a few minutes.";
  }
  if (kind === "verify" && (info.status === 401 || info.status === 400)) {
    return "That code is incorrect or has expired. Check the code, or request a new one.";
  }
  return info.message || (kind === "request" ? "Could not request a code." : "Could not verify the code.");
}
