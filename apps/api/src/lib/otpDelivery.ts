/**
 * Delivery of one-time codes by WhatsApp (Meta Cloud API, authentication-category template). This is the
 * ONLY channel for login and public-complaint codes: there is no SMS provider and email is not used.
 * The channel is a no-op until its credentials are set, so the feature can be shipped now and switched on
 * later by configuration alone - no code change.
 *
 *   WHATSAPP_ACCESS_TOKEN        system-user token
 *   WHATSAPP_PHONE_NUMBER_ID     the sending number's Phone Number ID
 *   WHATSAPP_OTP_TEMPLATE_NAME   approved authentication template (default "recd_otp")
 *   WHATSAPP_TEMPLATE_LANG       template language code (default "en")
 *   WHATSAPP_API_VERSION         Graph API version (default "v21.0")
 *
 * Local development without WhatsApp: set OTP_DEV_ECHO=1. Nothing is sent; the code is returned in the API
 * response so the flow can be tried. That switch is OFF by default and is ignored in production and on any
 * hosted platform (see devEchoAllowed). The old PUBLIC_OTP_DEV_ECHO=1 name is still honoured. A code is never
 * written to a log.
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

/** Local development only: nothing is sent and nothing is logged; the route echoes the code (see devEchoAllowed). */
class DevEchoProvider implements OtpDeliveryProvider {
  readonly name = "dev" as const;
  async send(): Promise<DeliveryResult> {
    return { ok: true };
  }
}

export function whatsAppConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

/** Environment variables that only exist on hosted platforms. A hosted deployment never discloses codes. */
const HOSTED_ENV_MARKERS = [
  "VERCEL",
  "VERCEL_ENV",
  "RENDER",
  "RAILWAY_ENVIRONMENT",
  "FLY_APP_NAME",
  "AWS_LAMBDA_FUNCTION_NAME",
  "K_SERVICE",
  "NETLIFY",
  "DYNO",
  "WEBSITE_SITE_NAME",
];

/** Production, or any recognised hosting platform. */
export function isHostedOrProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || HOSTED_ENV_MARKERS.some((k) => Boolean(env[k]));
}

/**
 * May a code be returned in the API response instead of being sent? Only on a developer's machine AND only
 * when explicitly switched on with OTP_DEV_ECHO=1 (or the older PUBLIC_OTP_DEV_ECHO=1). Off by default.
 */
export function devEchoAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isHostedOrProduction(env)) return false;
  return env.OTP_DEV_ECHO === "1" || env.PUBLIC_OTP_DEV_ECHO === "1";
}

/** The provider to use right now, or null when OTP delivery is not available. */
export function getOtpDelivery(env: NodeJS.ProcessEnv = process.env): OtpDeliveryProvider | null {
  if (whatsAppConfigured(env)) return new WhatsAppCloudProvider();
  if (devEchoAllowed(env)) return new DevEchoProvider();
  return null;
}
