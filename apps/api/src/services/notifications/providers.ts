import { NOTIFICATION_CHANNEL, type NotificationChannel } from "@recd/shared";
import { prisma } from "../../lib/prisma";
import { sendEmail } from "../../lib/email";
import { renderEmail } from "./emailTemplates";

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  /** Returns true if the message was actually delivered (not just stubbed). */
  send(args: { recipientId: string; templateKey: string; data: Record<string, unknown> }): Promise<boolean>;
}

/** In-app: writes a row the recipient's app polls/queries - always "delivered" once written. */
export class InAppProvider implements NotificationProvider {
  readonly channel = NOTIFICATION_CHANNEL.IN_APP;
  async send() {
    return true;
  }
}

/**
 * Email: real - sends over SMTP (see lib/email.ts), rendering copy from emailTemplates.ts.
 * Returns false (rather than throwing) when SMTP isn't configured or the recipient has no
 * address on file, so the notification is logged as undelivered instead of breaking the
 * request that triggered it.
 */
export class EmailProvider implements NotificationProvider {
  readonly channel = NOTIFICATION_CHANNEL.EMAIL;
  async send(args: { recipientId: string; templateKey: string; data: Record<string, unknown> }) {
    const user = await prisma.user.findUnique({ where: { id: args.recipientId }, select: { email: true } });
    if (!user?.email) {
      console.error(`[email] no email on file for user ${args.recipientId} - cannot send ${args.templateKey}`);
      return false;
    }

    const { subject, text, html } = renderEmail(args.templateKey, args.data);
    return sendEmail({ to: user.email, subject, text, html });
  }
}

/** SMS: deferred. Logs to NotificationLog with status pending_provider_setup, never marked delivered. */
export class SmsProvider implements NotificationProvider {
  readonly channel = NOTIFICATION_CHANNEL.SMS;
  async send() {
    return false;
  }
}

/** WhatsApp: deferred pending Business API approval. Same stub contract as SmsProvider. */
export class WhatsAppProvider implements NotificationProvider {
  readonly channel = NOTIFICATION_CHANNEL.WHATSAPP;
  async send() {
    return false;
  }
}

/** Telegram: deferred pending bot registration. Same stub contract as SmsProvider. */
export class TelegramProvider implements NotificationProvider {
  readonly channel = NOTIFICATION_CHANNEL.TELEGRAM;
  async send() {
    return false;
  }
}

export const providersByChannel: Record<NotificationChannel, NotificationProvider> = {
  [NOTIFICATION_CHANNEL.IN_APP]: new InAppProvider(),
  [NOTIFICATION_CHANNEL.EMAIL]: new EmailProvider(),
  [NOTIFICATION_CHANNEL.SMS]: new SmsProvider(),
  [NOTIFICATION_CHANNEL.WHATSAPP]: new WhatsAppProvider(),
  [NOTIFICATION_CHANNEL.TELEGRAM]: new TelegramProvider(),
};
