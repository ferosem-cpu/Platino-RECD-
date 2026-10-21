import { mobileStorageVariants } from "@recd/shared";
import { prisma } from "./prisma";

/**
 * Another user (staff, customer contact or vendor login: they all live in User) already holding this number in ANY
 * accepted stored format (bare, +91, 91 or 0 prefixed - older rows were not normalised). `normalized` must be the
 * 10-digit form. `exceptUserId` lets a user keep their own number. This is the one duplicate check shared by the
 * customer-contact and staff-user routes; the unique index on User.phone is the backstop for exact-value races.
 */
export async function phoneHeldByAnother(normalized: string, exceptUserId?: string) {
  return prisma.user.findFirst({
    where: { phone: { in: mobileStorageVariants(normalized) }, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    select: { id: true },
  });
}
