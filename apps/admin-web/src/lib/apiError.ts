/**
 * `api()` throws `Error(JSON.stringify(body.error))`: a plain string error arrives wrapped in
 * quotes and a zod validation error arrives as `{formErrors, fieldErrors}` JSON. This turns
 * either back into a sentence a user can read.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  try {
    const parsed: unknown = JSON.parse(err.message);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const { formErrors, fieldErrors } = parsed as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
      const parts = [
        ...(formErrors ?? []),
        ...Object.entries(fieldErrors ?? {}).flatMap(([field, msgs]) => msgs.map((m) => `${field}: ${m}`)),
      ];
      if (parts.length) return parts.join("; ");
    }
  } catch {
    // not JSON - already a readable message (e.g. "Request failed: 500")
  }
  return err.message;
}

/**
 * Removes a technical field-name prefix ("recdSerials: ") that `apiErrorMessage` puts in front of a validation message, leaving the
 * message itself. Only that exact field name is removed (at the start or after a "; " separator); everything else is kept.
 */
export function withoutFieldPrefix(message: string, field: string): string {
  return message.split("; ").map((part) => (part.startsWith(`${field}: `) ? part.slice(field.length + 2) : part)).join("; ");
}

/** What the browser throws when the server cannot be reached at all (its wording differs per browser). */
const NETWORK_ERROR = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * A message that is safe to show: meaningful 4xx answers (authorization, validation, conflicts) keep their wording, while a
 * network failure or a 5xx - whose text is browser or server internals - is replaced by `fallback`. The original error is
 * written to the developer console so nothing useful is lost.
 */
export function friendlyApiMessage(err: unknown, fallback: string): string {
  const status = (err as { status?: unknown } | null)?.status;
  const message = err instanceof Error ? err.message : "";
  const unreachable = err instanceof TypeError || NETWORK_ERROR.test(message);
  if (unreachable || (typeof status === "number" && status >= 500)) {
    console.error("[api] request failed", err);
    return fallback;
  }
  return apiErrorMessage(err, fallback);
}
