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

/**
 * "Sign in with Google" for staff (Super Admin etc). This is an *additional* staff login
 * path alongside email+password - it does not touch the customer login flow, which stays
 * RECD Serial Number + phone + emailed OTP (customerRegisterSchema/customerVerifySchema).
 */
export const googleLoginSchema = z.object({
  /** The ID token returned by Google Identity Services' credential callback (a signed JWT). */
  credential: z.string().min(1),
});

export const createOrderSchema = z.object({
  customerId: z.string(),
  productId: z.string(),
  quantity: z.number().int().positive(),
  // Optional: a sales-created order should still set these, but they're nullable on the
  // model to support operational orders created without commercial figures yet (e.g. a
  // site added before pricing is finalized).
  value: z.number().nonnegative().optional(),
  orderDate: z.string().datetime().optional(),
  promisedDeliveryDate: z.string().datetime().optional(),
  plannedExhaustHookupType: z.string().optional(),
});

/** Adds another RECD product to an existing order/site (same order, multiple units). */
export const addOrderLineItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
});

/**
 * Creates a sibling Order+Site for another RECD delivered to the same physical location -
 * same address/companyName/vendor as the source site, reset to the first stage, but its
 * own orderNumber so it's tracked independently.
 */
export const cloneOrderForSiteSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
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

export const updateSiteLocationSchema = z.object({
  address: z.string().optional(),
  gpsLat: z.number().min(-90).max(90).nullable().optional(),
  gpsLng: z.number().min(-180).max(180).nullable().optional(),
});

/** Site's own identity fields - end-client/site-owner name and address, editable independent of location capture. */
export const updateSiteDetailsSchema = z.object({
  companyName: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
});

export const createSiteContactSchema = z.object({
  name: z.string().min(1, "Name is required"),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  role: z.string().optional(),
});

export const updateSiteContactSchema = createSiteContactSchema.partial();

/** Bulk-set all document requirements for a site in one call (the UI presents them as a table). */
export const setSiteDocumentRequirementsSchema = z.object({
  requirements: z.array(
    z.object({
      requirementTypeId: z.string(),
      required: z.boolean(),
      status: z.string().optional(),
      documentUrl: z.string().url().optional(),
      notes: z.string().optional(),
    }),
  ),
});

export const upsertRecdDeliverySchema = z.object({
  productId: z.string().nullable().optional(),
  quantity: z.number().int().positive().nullable().optional(),
  deliveryStatus: z.string().optional(),
  statusNote: z.string().nullable().optional(),
  priority: z.number().int().nullable().optional(),
  expectedDate: z.string().datetime().nullable().optional(),
  actualDate: z.string().datetime().nullable().optional(),
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
  amcType: z.enum(["camc", "namc"]),
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

export const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  contactName: z.string().min(1).optional(),
  contactPhone: z.string().min(6).optional(),
  contactEmail: z.string().email().optional(),
});

export const createProductSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  ratingSpec: z.string().optional(),
  capacityKva: z.number().optional(),
  warrantyMonths: z.number().int().optional(),
  shape: z.enum(["cylinder", "triangle", "rectangle"]).optional(),
  dimensions: z.string().optional(),
  weightKg: z.number().optional(),
  silencerType: z.union([z.literal(1), z.literal(2)]).optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const registerVendorSchema = z.object({
  name: z.string().min(1),
  contactName: z.string().min(1),
  // Email is the vendor contact's login once approved, so it must be unique + valid.
  contactEmail: z.string().email(),
  contactPhone: z.string().optional(),
  address: z.string().optional(),
});

/** Optional: move this vendor's currently-assigned sites to another approved vendor before
 * archiving, so ongoing erection work doesn't stall. Omit to leave sites pointed at the
 * archived vendor (fine for work that's already finished). */
export const archiveVendorSchema = z.object({
  reassignSitesToVendorId: z.string().optional(),
});

/** Assign (or clear) the external vendor responsible for a site, and optionally its engineer. */
export const assignSiteVendorSchema = z.object({
  vendorId: z.string().nullable(),
  assignedEngineerId: z.string().nullable().optional(),
});
