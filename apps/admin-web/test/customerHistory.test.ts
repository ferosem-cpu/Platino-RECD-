import test from "node:test";
import assert from "node:assert/strict";
import {
  SERIAL_MISSING_LABEL,
  complaintsOfCustomer,
  customerHistoryCsvRows,
  HISTORY_CSV_HEADERS,
  orderSerialsText,
  unitSerialLabel,
  type HistoryComplaint,
  type HistoryOrder,
} from "../src/lib/customerHistory";
import { buildCsv } from "../src/lib/csvExport";

const order = (over: Partial<HistoryOrder> = {}): HistoryOrder => ({
  orderNumber: "ORD-1",
  orderDate: "2026-03-01T00:00:00.000Z",
  value: "850000",
  product: { name: "RECD" },
  units: [{ id: "u1", serialNo: "SN-1" }, { id: "u2", serialNo: null }],
  site: { companyName: "Site A", currentStage: { label: "Order received" } },
  ...over,
});

const complaint = (over: Partial<HistoryComplaint> = {}): HistoryComplaint => ({
  ticketNumber: "TCK-1",
  customerId: "cA",
  category: "non_performance",
  status: "open",
  createdAt: "2026-04-01T00:00:00.000Z",
  unit: { id: "u1", serialNo: "SN-1" },
  ...over,
});

test("a missing serial is labelled, never blank or an error", () => {
  assert.equal(unitSerialLabel({ id: "u", serialNo: "SN-1" }), "SN-1");
  assert.equal(unitSerialLabel({ id: "u", serialNo: null }), SERIAL_MISSING_LABEL);
  assert.equal(orderSerialsText([]), "");
  assert.equal(orderSerialsText(order().units), `SN-1, ${SERIAL_MISSING_LABEL}`);
});

test("CSV rows carry the right serial on each order and complaint row", () => {
  const rows = customerHistoryCsvRows([order()], [complaint(), complaint({ ticketNumber: "TCK-2", unit: null })]);
  assert.equal(HISTORY_CSV_HEADERS[2], "RECD serial no.");
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0][0], rows[0][1], rows[0][2]], ["Order", "ORD-1", `SN-1, ${SERIAL_MISSING_LABEL}`]);
  assert.equal(rows[0][4], "RECD — Site A");
  assert.deepEqual([rows[1][0], rows[1][1], rows[1][2]], ["Complaint", "TCK-1", "SN-1"]);
  assert.deepEqual([rows[2][1], rows[2][2]], ["TCK-2", ""], "a ticket with no unit has an empty serial, not an error");
  for (const r of rows) assert.equal(r.length, HISTORY_CSV_HEADERS.length);
});

test("orders without units or without a site do not break the export", () => {
  const rows = customerHistoryCsvRows([order({ units: [], site: null, orderDate: null, value: null })], []);
  assert.deepEqual(rows[0], ["Order", "ORD-1", "", "", "RECD — no site", "", ""]);
});

test("only the chosen customer's complaints end up in the report", () => {
  const all = [complaint(), complaint({ ticketNumber: "TCK-9", customerId: "cB" })];
  assert.deepEqual(complaintsOfCustomer(all, "cA").map((c) => c.ticketNumber), ["TCK-1"]);
});

test("hostile text in a complaint row cannot become a spreadsheet formula in the export", () => {
  const rows = customerHistoryCsvRows([], [complaint({ category: "=cmd|' /C calc'!A0", status: "@evil" })]);
  const csv = buildCsv(HISTORY_CSV_HEADERS, rows);
  const line = csv.split("\r\n")[1];
  assert.ok(line.includes(",'=cmd"), line);
  assert.ok(line.includes(",'@evil"), line);
});
