import { NOTIFICATION_CHANNEL, type NotificationChannel } from "@recd/shared";

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
 * Email: real in Phase 1. No provider account wired up yet in this scaffold -
 * swap the body of this method for your transactional email provider
 * (Resend/SendGrid/SES) and it becomes live with no change to any caller.
 */
export class EmailProvider implements NotificationProvider {
  readonly channel = NOTIFICATION_CHANNEL.EMAIL;
  async send(args: { recipientId: string; templateKey: string; data: Record<string, unknown> }) {
    console.log(`[email] -> user ${args.recipientId} :: ${args.templateKey}`, args.data);
    return true;
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
