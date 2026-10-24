// A small interpreter for the Prisma "where" shapes used by the reminder code, so mocked tests run the real query intent
// against in-memory rows: equality, null, { not, in, notIn, lt, lte, gt, gte }, OR / AND, nested relations ({ site: { regionId } })
// and { some }. It is a test aid only - it proves application logic, NOT database behaviour.
/* eslint-disable @typescript-eslint/no-explicit-any */
const time = (v: any) => (v instanceof Date ? v.getTime() : v);
const isOperatorObject = (c: any) => c && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c) && Object.keys(c).some((k) => ["not", "in", "notIn", "lt", "lte", "gt", "gte", "some", "equals"].includes(k));

function matchValue(actual: any, cond: any): boolean {
  if (cond === null) return actual === null || actual === undefined;
  if (cond instanceof Date || typeof cond !== "object") return time(actual) === time(cond);
  if (isOperatorObject(cond)) {
    if ("equals" in cond && time(actual) !== time(cond.equals)) return false;
    if ("not" in cond) {
      if (cond.not === null ? actual === null || actual === undefined : time(actual) === time(cond.not)) return false;
    }
    if ("in" in cond && !cond.in.map(time).includes(time(actual))) return false;
    if ("notIn" in cond && cond.notIn.map(time).includes(time(actual))) return false;
    if ("lt" in cond && !(actual != null && time(actual) < time(cond.lt))) return false;
    if ("lte" in cond && !(actual != null && time(actual) <= time(cond.lte))) return false;
    if ("gt" in cond && !(actual != null && time(actual) > time(cond.gt))) return false;
    if ("gte" in cond && !(actual != null && time(actual) >= time(cond.gte))) return false;
    if ("some" in cond) return Array.isArray(actual) && actual.some((item) => deepMatch(item, cond.some));
    return true;
  }
  // nested relation filter
  if (actual === null || actual === undefined) return false;
  return deepMatch(actual, cond);
}

export function deepMatch(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as any[]).some((w) => deepMatch(row, w));
    if (key === "AND") return (cond as any[]).every((w) => deepMatch(row, w));
    return matchValue(row[key], cond);
  });
}
