import type { AgentLlmProvider } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { decryptSecret } from "../../lib/crypto";
import type { LlmAdapter } from "./types";
import { createAnthropicAdapter } from "./anthropicAdapter";
import { createOpenAICompatibleAdapter } from "./openaiCompatibleAdapter";

export const PROVIDER_TYPES = ["anthropic", "openai_compatible"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export function isValidProviderType(value: string): value is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

export function createAdapterForRow(row: AgentLlmProvider): LlmAdapter {
  const apiKey = decryptSecret(row.apiKeyCiphertext);

  if (row.providerType === "anthropic") {
    return createAnthropicAdapter({ providerName: row.name, apiKey, model: row.model });
  }
  if (row.providerType === "openai_compatible") {
    return createOpenAICompatibleAdapter({
      providerName: row.name,
      apiKey,
      model: row.model,
      baseUrl: row.baseUrl ?? undefined,
    });
  }
  throw new Error(`Unknown provider type "${row.providerType}" on provider "${row.name}".`);
}

/** Active providers, in the order they should be tried (lowest priority number first). */
export async function loadActiveProvidersInOrder(): Promise<AgentLlmProvider[]> {
  return prisma.agentLlmProvider.findMany({
    where: { isActive: true },
    orderBy: { priority: "asc" },
  });
}
