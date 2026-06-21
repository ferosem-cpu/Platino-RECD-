import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { LIVE_NOTIFICATION_CHANNELS, type NotificationChannel } from "@recd/shared";
import { providersByChannel } from "./providers";

interface SendArgs {
  recipientId: string;
  templateKey: string;
  data: Record<string, unknown>;
  /** Defaults to the recipient's saved preference, falling back to in_app + email. */
  channels?: NotificationChannel[];
}

const DEFAULT_CHANNELS: NotificationChannel[] = ["in_app", "email"];

export async function send({ recipientId, templateKey, data, channels }: SendArgs) {
  let targetChannels = channels;
  if (!targetChannels) {
    const user = await prisma.user.findUnique({ where: { id: recipientId } });
    const saved = (user?.notificationChannels as NotificationChannel[] | null) ?? null;
    targetChannels = saved && saved.length > 0 ? saved : DEFAULT_CHANNELS;
  }

  const results = await Promise.all(
    targetChannels.map(async (channel) => {
      const provider = providersByChannel[channel];
      const delivered = await provider.send({ recipientId, templateKey, data });
      const isLive = LIVE_NOTIFICATION_CHANNELS.includes(channel);
      return prisma.notificationLog.create({
        data: {
          recipientId,
          channel,
          templateKey,
          payload: data as Prisma.InputJsonValue,
          status: delivered ? "sent" : isLive ? "failed" : "pending_provider_setup",
          sentAt: delivered ? new Date() : null,
        },
      });
    }),
  );
  return results;
}
