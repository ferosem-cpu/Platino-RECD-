import type { ParsedQs } from "qs";

type ParamLike = string | ParsedQs | (string | ParsedQs)[] | undefined;

/**
 * Express types req.params/req.query values as unions wide enough to cover repeated
 * keys (`?foo=1&foo=2`) and nested objects (`?foo[bar]=1`, via the `qs` parser). None
 * of this API's routes use either, so this narrows back to the single string every
 * call site actually expects - and, just as importantly, keeps that union out of
 * Prisma's `where` calls, where it was breaking generic inference for the whole query
 * (symptom: unrelated "property does not exist" errors on properties that were, in
 * fact, included - the inference failure cascades past the actual mismatch).
 */
export function asString(value: ParamLike): string {
  const narrowed = asOptionalString(value);
  if (narrowed === undefined) throw new Error("Missing required parameter");
  return narrowed;
}

export function asOptionalString(value: ParamLike): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}
