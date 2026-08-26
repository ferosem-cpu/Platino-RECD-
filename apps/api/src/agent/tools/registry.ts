import type { AgentTool } from "./types";
import { driveTools } from "./driveTool";
import { appReadTools } from "./appReadTools";
import { getDocumentDetailTool } from "./appDetailTool";
import { appWriteTools } from "./appWriteTools";

// The upstream fork's finance-module write tools (create_expense / create_quotation /
// create_invoice / create_purchase_order) still aren't part of this app - no finance module
// here. create_order and create_product ARE, behind the same AgentPendingAction confirm-gate
// pattern (see appWriteTools.ts).
export const allTools: AgentTool[] = [
  ...driveTools,
  ...appReadTools,
  getDocumentDetailTool,
  ...appWriteTools,
];

export function getToolByName(name: string): AgentTool | undefined {
  return allTools.find((t) => t.name === name);
}
