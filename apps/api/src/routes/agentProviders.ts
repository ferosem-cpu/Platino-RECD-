/** CRUD for the in-app agent's LLM provider settings (name/key/model/priority/fallback).
 * Super-Admin only (MANAGE_SETTINGS), same gate as company settings - matches the original
 * decision that agent configuration is a Super-Admin concern. The encrypted API key is
 * NEVER included in any response - only whether one is set (hasApiKey).
 */
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { authenticate, requirePermission, type AuthenticatedRequest } from "../middleware/auth";
import { PERMISSION_KEY } from "@recd/shared";
import { encryptSecret } from "../lib/crypto";
import { isValidProviderType, PROVIDER_TYPES } from "../agent/providers/factory";

export const agentProvidersRouter = Router();

function toPublicShape(row: {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string | null;
  model: string;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    baseUrl: row.baseUrl,
    model: row.model,
    priority: row.priority,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

agentProvidersRouter.get(
  "/providers",
  authenticate,
  requirePermission(PERMISSION_KEY.MANAGE_SETTINGS),
  async (_req, res) => {
    const rows = await prisma.agentLlmProvider.findMany({ orderBy: { priority: "asc" } });
    res.json({ providers: rows.map(toPublicShape), availableProviderTypes: PROVIDER_TYPES });
  },
);

agentProvidersRouter.post(
  "/providers",
  authenticate,
  requirePermission(PERMISSION_KEY.MANAGE_SETTINGS),
  async (req: AuthenticatedRequest, res) => {
    const { name, providerType, apiKey, baseUrl, model, priority, isActive } = req.body as {
      name?: string;
      providerType?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      priority?: number;
      isActive?: boolean;
    };

    if (!name || !providerType || !apiKey || !model) {
      return res.status(400).json({ error: "name, providerType, apiKey, and model are required" });
    }
    if (!isValidProviderType(providerType)) {
      return res.status(400).json({ error: `providerType must be one of: ${PROVIDER_TYPES.join(", ")}` });
    }
    if (!req.auth) return res.status(401).json({ error: "Not authenticated" });

    const row = await prisma.agentLlmProvider.create({
      data: {
        name,
        providerType,
        apiKeyCiphertext: encryptSecret(apiKey),
        baseUrl: baseUrl || null,
        model,
        priority: priority ?? 0,
        isActive: isActive ?? true,
        createdById: req.auth.userId,
      },
    });
    res.status(201).json(toPublicShape(row));
  },
);

agentProvidersRouter.put(
  "/providers/:id",
  authenticate,
  requirePermission(PERMISSION_KEY.MANAGE_SETTINGS),
  async (req: AuthenticatedRequest, res) => {
    const { name, providerType, apiKey, baseUrl, model, priority, isActive } = req.body as {
      name?: string;
      providerType?: string;
      apiKey?: string;
      baseUrl?: string | null;
      model?: string;
      priority?: number;
      isActive?: boolean;
    };

    if (providerType !== undefined && !isValidProviderType(providerType)) {
      return res.status(400).json({ error: `providerType must be one of: ${PROVIDER_TYPES.join(", ")}` });
    }

    try {
      const row = await prisma.agentLlmProvider.update({
        where: { id: String(req.params.id) },
        data: {
          name,
          providerType,
          // Only re-encrypt and overwrite if a new key was actually provided - omitting
          // apiKey in the request means "keep the existing key".
          ...(apiKey ? { apiKeyCiphertext: encryptSecret(apiKey) } : {}),
          baseUrl: baseUrl === undefined ? undefined : baseUrl,
          model,
          priority,
          isActive,
        },
      });
      res.json(toPublicShape(row));
    } catch {
      res.status(404).json({ error: "Provider not found" });
    }
  },
);

agentProvidersRouter.delete(
  "/providers/:id",
  authenticate,
  requirePermission(PERMISSION_KEY.MANAGE_SETTINGS),
  async (req, res) => {
    try {
      await prisma.agentLlmProvider.delete({ where: { id: String(req.params.id) } });
      res.status(204).send();
    } catch {
      res.status(404).json({ error: "Provider not found" });
    }
  },
);

/** Probes the provider's own models-list endpoint with the pasted (not-yet-saved) key, so
 * the Settings UI can populate a real model dropdown instead of a free-text field. Nothing
 * here is persisted - it's a live lookup only. Returns 200 with an empty list + `error` on
 * any failure (bad key, provider doesn't support listing, network issue) so the frontend can
 * fall back to manual entry rather than treating this as a hard failure.
 */
agentProvidersRouter.post(
  "/providers/list-models",
  authenticate,
  requirePermission(PERMISSION_KEY.MANAGE_SETTINGS),
  async (req, res) => {
    const { providerType, apiKey, baseUrl } = req.body as {
      providerType?: string;
      apiKey?: string;
      baseUrl?: string;
    };
    if (!providerType || !apiKey) {
      return res.status(400).json({ error: "providerType and apiKey are required" });
    }
    if (!isValidProviderType(providerType)) {
      return res.status(400).json({ error: `providerType must be one of: ${PROVIDER_TYPES.join(", ")}` });
    }

    try {
      if (providerType === "anthropic") {
        const response = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        });
        if (!response.ok) {
          return res.json({ models: [], error: `Anthropic returned ${response.status}` });
        }
        const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
        const models = (data.data ?? []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
        return res.json({ models });
      }

      // openai_compatible - works for OpenAI itself and any provider exposing the same
      // /models route (Groq, DeepSeek, OpenRouter, Together, Mistral, Gemini's compat layer, etc).
      const base = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const response = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return res.json({ models: [], error: `Provider returned ${response.status} - you can still type a model name manually.` });
      }
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const models = (data.data ?? [])
        .map((m) => ({ id: m.id, label: m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return res.json({ models });
    } catch (err) {
      return res.json({ models: [], error: (err as Error).message });
    }
  },
);
