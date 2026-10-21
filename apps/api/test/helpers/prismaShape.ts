// Applies a Prisma `select` / `include` argument to an in-memory record graph, the way the real client shapes a query result:
//  - no argument            -> the record's scalar columns only;
//  - include: { rel: true } -> scalars + that relation with ALL of ITS scalar columns (this is what leaks a User's passwordHash);
//  - include: { rel: {select|include: ...} } / select: { field: true, rel: {...} } -> exactly what is asked for, recursively.
// Tests keep related records embedded in the fixture (e.g. site.assignedEngineer = <full user row>); this helper decides how much of
// it a route's query would actually have returned. It checks the SHAPE a route asks for - it is not a database.
/* eslint-disable @typescript-eslint/no-explicit-any */
const isRelation = (v: unknown): boolean => v !== null && typeof v === "object" && !(v instanceof Date);

export function scalarsOf(row: any): any {
  if (row === null || row === undefined) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!isRelation(v)) out[k] = v;
  return out;
}

export function shape(row: any, args?: { select?: Record<string, any>; include?: Record<string, any> } | null): any {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map((r) => shape(r, args));
  if (!args || (!args.select && !args.include)) return scalarsOf(row);

  if (args.select) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.select)) {
      if (v === false || v === undefined) continue;
      if (v === true) out[k] = isRelation(row[k]) && !Array.isArray(row[k]) ? scalarsOf(row[k]) : Array.isArray(row[k]) ? row[k].map(scalarsOf) : row[k];
      else out[k] = shape(row[k], v);
    }
    return out;
  }

  const out: Record<string, unknown> = scalarsOf(row);
  for (const [k, v] of Object.entries(args.include!)) {
    if (v === false || v === undefined) continue;
    out[k] = v === true ? shape(row[k], null) : shape(row[k], v);
  }
  return out;
}

/** Every key anywhere in a JSON-able value (to assert that a forbidden field name appears nowhere in a response). */
export function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, into);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { into.add(k); allKeys(v, into); }
  return into;
}
