import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const requestOtpSchema = z.object({
  phone: z.string().min(8),
});

export const verifyOtpSchema = z.object({
  phone: z.string().min(8),
  code: z.string().length(6),
});

export const createOrderSchema = z.object({
  customerId: z.string(),
  productId: z.string(),
  quantity: z.number().int().positive(),
  value: z.number().nonnegative(),
  orderDate: z.string().datetime(),
  promisedDeliveryDate: z.string().datetime().optional(),
  plannedExhaustHookupType: z.string().optional(),
});

export const createStageEventSchema = z.object({
  stageDefinitionId: z.string(),
  statusOptionId: z.string(),
  comment: z.string().min(1, "Comment is required"),
  photoUrl: z.string().url().optional(),
});

export const confirmExhaustHookupSchema = z.object({
  confirmedExhaustHookupType: z.string(),
  matchesPlan: z.boolean(),
});

export const uploadSitePhotoSchema = z.object({
  checkpointId: z.string(),
  photoUrl: z.string().url(),
  caption: z.string().optional(),
});

export const createComplaintSchema = z.object({
  siteId: z.string(),
  category: z.string(),
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
});

export const updateComplaintStatusSchema = z.object({
  status: z.string(),
  rootCause: z.string().optional(),
  resolutionNotes: z.string().optional(),
});

export const resolvePendingActionSchema = z.object({
  resolution: z.string(),
  notes: z.string().optional(),
});

export const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  roleKey: z.string(),
  phone: z.string().optional(),
});

export const notificationPreferenceSchema = z.object({
  channels: z.array(z.enum(["in_app", "email", "sms", "whatsapp", "telegram"])),
});
