import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/** E.164-ish mobile number: optional leading +, 8-15 digits, no leading zero. */
export const MOBILE_NUMBER_REGEX = /^\+?[1-9]\d{7,14}$/;

/**
 * Indian mobile number: 10 digits starting 6-9. Accepts a +91 / 91 / 0 prefix and common
 * separators on input and normalises to the bare 10 digits, so the same number can never be
 * stored two ways (matters for OTP delivery and duplicate checks).
 */
export function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  const bare = digits.replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(bare) ? bare : null;
}

export const indianMobileSchema = z
  .string()
  .transform((v, ctx) => {
    const n = normalizeIndianMobile(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid 10-digit Indian mobile number" });
      return z.NEVER;
    }
    return n;
  });

/** RECD serial: 3-40 chars, letters/digits and - _ / . only; stored upper-case. */
export const recdSerialSchema = z
  .string()
  .trim()
  .min(3, "Serial number is too short")
  .max(40, "Serial number is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9\-_/.]*$/, "Use letters, digits and - _ / . only")
  .transform((v) => v.toUpperCase());

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
  /** Customer's purchase order number. Duplicates for the same customer are rejected unless
   *  an admin passes allowDuplicatePo, in which case the order is flagged. */
  poNumber: z.string().trim().min(1, "PO number is required").max(60),
  poDate: z.string().datetime().optional(),
  allowDuplicatePo: z.boolean().optional(),
  /** One serial per physical RECD: exactly `quantity` of them. */
  recdSerials: z.array(recdSerialSchema),
}).superRefine((v, ctx) => {
  if (v.recdSerials.length !== v.quantity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recdSerials"], message: `Enter ${v.quantity} RECD serial number(s) - one per unit` });
  }
  if (new Set(v.recdSerials).size !== v.recdSerials.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recdSerials"], message: "Duplicate serial numbers in this order" });
  }
});

/** Adds another RECD product to an existing order/site (same order, multiple units). */
export const addOrderLineItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  /** One serial per unit added. */
  recdSerials: z.array(recdSerialSchema),
}).superRefine((v, ctx) => {
  if (v.recdSerials.length !== v.quantity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recdSerials"], message: `Enter ${v.quantity} RECD serial number(s) - one per unit` });
  }
  if (new Set(v.recdSerials).size !== v.recdSerials.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recdSerials"], message: "Duplicate serial numbers" });
  }
});

/** Sets the serial on a unit that was created without one (legacy / agent-created). */
export const setRecdSerialSchema = z.object({ serialNo: recdSerialSchema });

export const createRegionSchema = z.object({
  name: z.string().trim().min(2).max(80),
});
export const updateRegionSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
});
export const setRegionManagersSchema = z.object({ userIds: z.array(z.string()) });
export const setSiteRegionSchema = z.object({ regionId: z.string().nullable() });

/**
 * Creates a sibling Order+Site for another RECD delivered to the same physical location -
 * same address/companyName/vendor as the source site, reset to the first stage, but its
 * own orderNumber so it's tracked independently.
 */
export const cloneOrderForSiteSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive(),
  /** One serial per unit. */
  recdSerials: z.array(recdSerialSchema),
}).superRefine((v, ctx) => {
  if (v.recdSerials.length !== v.quantity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recdSerials"], message: `Enter ${v.quantity} RECD serial number(s) - one per unit` });
  }
  if (new Set(v.recdSerials).size !== v.recdSerials.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recdSerials"], message: "Duplicate serial numbers" });
  }
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
  /** Specific RECD the ticket is about (must belong to siteId). When set, the one-open-ticket
   *  rule applies per unit instead of per site. */
  unitId: z.string().optional(),
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
  sitePocNumber: indianMobileSchema,
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
  /** Mandatory: it is the contact number for reminders/OTP. Normalised to 10 digits. */
  phone: indianMobileSchema,
  title: z.string().optional(),
  /** Required when adding an erection engineer who belongs to an approved vendor. */
  vendorId: z.string().optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  roleKey: z.string().optional(),
  phone: indianMobileSchema.optional(),
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

// ---------------------------------------------------------------------------
// Public complaint flow: RECD serial number + mobile number + OTP (no login)
// ---------------------------------------------------------------------------

export const publicOtpRequestSchema = z.object({
  serialNo: recdSerialSchema,
  phone: indianMobileSchema,
});

export const publicOtpVerifySchema = z.object({
  serialNo: recdSerialSchema,
  phone: indianMobileSchema,
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const publicComplaintSchema = z.object({
  /** Single-use token returned by a successful OTP verification. */
  sessionToken: z.string().min(32).max(128),
  reporterName: z.string().trim().min(2, "Enter your name").max(80),
  reporterType: z.enum(["customer", "reseller", "re_reseller", "other"]),
  issueCategory: z.string().min(1),
  description: z.string().trim().min(10, "Describe the problem (at least 10 characters)").max(2000),
  /** Optional photo of the RECD/DG nameplate or the fault - image data URL, max ~6 MB. */
  attachmentUrl: z
    .string()
    .max(8_000_000)
    .regex(/^data:image\/(png|jpe?g|webp);base64,/, "Attach a PNG, JPG or WebP image")
    .optional(),
});

export const slaSettingsSchema = z
  .object({
    slaRegionalManagerHours: z.number().int().min(1).max(720),
    slaManagementHours: z.number().int().min(1).max(1440),
  })
  .refine((v) => v.slaManagementHours >= v.slaRegionalManagerHours, {
    message: "Management escalation must be at or after the Regional Manager escalation",
    path: ["slaManagementHours"],
  });
