import type { AgentTool } from "./types";
import { driveTools } from "./driveTool";
import { appReadTools } from "./appReadTools";
import { getDocumentDetailTool } from "./appDetailTool";

// Read tools + Drive tools only. The upstream fork also registers write tools
// (create_expense / create_quotation / create_invoice / create_purchase_order) behind an
// AgentPendingAction confirm-gate; those are finance-module features and are not part of
// this app, so neither the tools nor the pending-action table were ported.
export const allTools: AgentTool[] = [
  ...driveTools,
  ...appReadTools,
  getDocumentDetailTool,
];

export function getToolByName(name: string): AgentTool | undefined {
  return allTools.find((t) => t.name === name);
}
