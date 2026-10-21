import { formatDate } from "./format";

/** Shown wherever a RECD has no serial number on file yet (legacy units). */
export const SERIAL_MISSING_LABEL = "Serial not entered";

export interface HistoryUnit {
  id: string;
  serialNo: string | null;
}

export interface HistoryOrder {
  orderNumber: string;
  orderDate: string | null;
  value: string | null;
  product: { name: string };
  /** RECD units on the order (GET /customers/:id). */
  units: HistoryUnit[];
  site: { companyName: string | null; currentStage: { label: string } } | null;
}

export interface HistoryComplaint {
  ticketNumber: string;
  customerId: string;
  category: string;
  status: string;
  createdAt: string;
  /** The RECD the ticket was raised against (GET /complaints); null on legacy tickets. */
  unit?: HistoryUnit | null;
}

/** One unit's serial for display: its serial, or a clear label when it has none. */
export function unitSerialLabel(unit: HistoryUnit): string {
  return unit.serialNo ?? SERIAL_MISSING_LABEL;
}

/** All of an order's units' serials, comma-separated; empty when the order has no units. */
export function orderSerialsText(units: HistoryUnit[]): string {
  return units.map(unitSerialLabel).join(", ");
}

/** Only this customer's tickets: /complaints returns every ticket the caller may see. */
export function complaintsOfCustomer<T extends { customerId: string }>(all: T[], customerId: string): T[] {
  return all.filter((c) => c.customerId === customerId);
}

export const HISTORY_CSV_HEADERS = ["Section", "Reference", "RECD serial no.", "Date", "Detail", "Status", "Amount"];

/** CSV rows for the customer-history report: orders first, then complaints. */
export function customerHistoryCsvRows(orders: HistoryOrder[], complaints: HistoryComplaint[]): string[][] {
  return [
    ...orders.map((o) => [
      "Order",
      o.orderNumber,
      orderSerialsText(o.units),
      o.orderDate ? formatDate(o.orderDate) : "",
      `${o.product.name} — ${o.site?.companyName ?? "no site"}`,
      o.site?.currentStage.label ?? "",
      o.value ?? "",
    ]),
    ...complaints.map((c) => [
      "Complaint",
      c.ticketNumber,
      c.unit ? unitSerialLabel(c.unit) : "",
      formatDate(c.createdAt),
      c.category,
      c.status,
      "",
    ]),
  ];
}
