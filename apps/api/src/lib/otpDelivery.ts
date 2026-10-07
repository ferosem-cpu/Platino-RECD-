/**
 * Delivery of the public complaint OTP. There is deliberately no SMS provider; WhatsApp (Meta
 * Cloud API, authentication-category template) is the production channel and is a no-op until
 * its credentials are set, so the feature can be shipped now and switched on later by
 * configuration alone - no code change.
 *
 *   WHATSAPP_ACCESS_TOKEN        system-user token
 *   WHATSAPP_PHONE_NUMBER_ID     the sending number's Phone Number ID
 *   WHATSAPP_OTP_TEMPLATE_NAME   approved authentication template (default "recd_otp")
 *   WHATSAPP_TEMPLATE_LANG       template language code (default "en")
 *   WHATSAPP_API_VERSION         Graph API version (default "v21.0")
 *
 * Without WhatsApp, a console "dev" channel is available OUTSIDE production only, and can echo
 * the code back to the caller when PUBLIC_OTP_DEV_ECHO=1 (never honoured on Vercel production).
 */

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

export interface OtpDeliveryProvider {
  readonly name: "whatsapp" | "dev";
  send(phone10: string, code: string): Promise<DeliveryResult>;
}

/** Template payload for a Meta authentication template with a "copy code" button. */
export function buildWhatsAppOtpPayload(phone10: string, code: string, templateName: string, lang: string) {
  return {
    messaging_product: "whatsapp",
    to: `91${phone10}`,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: [
        { type: "body", parameters: [{ type: "text", text: code }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
      ],
    },
  };
}

class WhatsAppCloudProvider implements OtpDeliveryProvider {
  readonly name = "whatsapp" as const;
  async send(phone10: string, code: string): Promise<DeliveryResult> {
    const token = process.env.WHATSAPP_ACCESS_TOKEN!;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
    const version = process.env.WHATSAPP_API_VERSION || "v21.0";
    const payload = buildWhatsAppOtpPayload(
      phone10,
      code,
      process.env.WHATSAPP_OTP_TEMPLATE_NAME || "recd_otp",
      process.env.WHATSAPP_TEMPLATE_LANG || "en",
    );
    try {
      const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Log Meta's error body server-side only; the code itself never appears in it.
        const body = await res.text().catch(() => "");
        console.error(`[otp] WhatsApp send failed ${res.status}: ${body.slice(0, 300)}`);
        return { ok: false, error: `whatsapp_${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      console.error("[otp] WhatsApp send error", err instanceof Error ? err.message : err);
      return { ok: false, error: "whatsapp_unreachable" };
    }
  }
}

class DevConsoleProvider implements OtpDeliveryProvider {
  readonly name = "dev" as const;
  async send(phone10: string, code: string): Promise<DeliveryResult> {
    console.log(`[otp:dev] code for ${phone10}: ${code}`);
    return { ok: true };
  }
}

export function whatsAppConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

export function devChannelAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production";
}

/** Whether the code may be echoed in the API response (local development only). */
export function devEchoAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return devChannelAllowed(env) && env.PUBLIC_OTP_DEV_ECHO === "1";
}

/** The provider to use right now, or null when public OTP is not available (feature off). */
export function getOtpDelivery(env: NodeJS.ProcessEnv = process.env): OtpDeliveryProvider | null {
  if (whatsAppConfigured(env)) return new WhatsAppCloudProvider();
  if (devChannelAllowed(env)) return new DevConsoleProvider();
  return null;
}
