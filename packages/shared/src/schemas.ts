import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/** E.164-ish mobile number: optional leading +, 8-15 digits, no leading zero. */
export const MOBILE_NUMBER_REGEX = /^\+?[1-9]\d{7,14}$/;

export const requestOtpSchema = z.object({
  phone: z.string().regex(MOBILE_NUMBER_REGEX, "Enter a valid mobile number"),
});

export const verifyOtpSchema = z.object({
  phone: z.string().regex(MOBILE_NUMBER_REGEX, "Enter a valid mobile number"),
  code: z.string().length(6),
});

export const customerRegisterSchema = z.object({
  orderNumber: z.string().min(1),
  phone: z.string().regex(MOBILE_NUMBER_REGEX, "Enter a valid mobile number"),
});

export const customerVerifySchema = z.object({
  orderNumber: z.string().min(1),
  phone: z.string().regex(MOBILE_NUMBER_REGEX, "Enter a valid mobile number"),
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
  issueCategory: z.string().optional(),
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  /** Photo of the RECD/DG nameplate - mandatory on the customer complaint form. */
  attachmentUrl: z.string().min(1, "A photo attachment is required"),
});

export const updateComplaintStatusSchema = z.object({
  status: z.string(),
  rootCause: z.string().optional(),
  resolutionNotes: z.string().optional(),
  remarks: z.string().optional(),
  serviceReportUrl: z.string().optional(),
  /** Only complaint managers (service team / management) may (re)assign; field engineers cannot. */
  assignedToId: z.string().nullable().optional(),
});

export const siteCompanyDetailsSchema = z.object({
  companyName: z.string().min(1),
  address: z.string().min(1),
  dgCapacityKva: z.number().positive(),
  dgModel: z.string().min(1),
  sitePocName: z.string().min(1),
  sitePocNumber: z.string().min(1),
});

export const createAmcOrderSchema = z.object({
  poNo: z.string().min(1),
  poDate: z.string().datetime(),
  customerId: z.string(),
  location: z.string().min(1),
  item: z.string().min(1),
  qty: z.number().int().positive(),
  amcFrequencyPerYear: z.number().int().positive(),
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
  title: z.string().optional(),
  /** Required when adding an erection engineer who belongs to an approved vendor. */
  vendorId: z.string().optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  roleKey: z.string().optional(),
  phone: z.string().optional(),
  title: z.string().optional(),
});

export const notificationPreferenceSchema = z.object({
  channels: z.array(z.enum(["in_app", "email", "sms", "whatsapp", "telegram"])),
});

export const createCustomerSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  contactName: z.string().min(1),
  // Phone is the customer's login credential (Order ID + phone -> OTP), so it is required.
  contactPhone: z.string().min(6),
  contactEmail: z.string().email().optional(),
});

export const registerVendorSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().min(1),
  // Email is the vendor contact's login once approved, so it must be unique + valid.
  contactEmail: z.string().email(),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
});

/** Assign (or clear) the external vendor responsible for a site, and optionally its engineer. */
export const assignSiteVendorSchema = z.object({
  vendorId: z.string().nullable(),
  assignedEngineerId: z.string().nullable().optional(),
});
