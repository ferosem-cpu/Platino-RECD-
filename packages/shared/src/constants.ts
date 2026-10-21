/**
 * Stages, statuses, roles, channels, and checkpoints all live as rows in the
 * database (see apps/api/prisma/schema.prisma + seed.ts) so new ones can be
 * added later without a code change. The keys below are the subset that
 * application logic itself needs to branch on - they must match the `key`
 * column of the corresponding seeded row exactly.
 */

export const SITC_PHASE = {
  SUPPLY: "SUPPLY",
  INSTALLATION: "INSTALLATION",
  TESTING: "TESTING",
  COMMISSIONING: "COMMISSIONING",
} as const;
export type SitcPhase = (typeof SITC_PHASE)[keyof typeof SITC_PHASE];

export const STAGE_KEY = {
  ORDER_RECEIVED: "order_received",
  DISPATCHED: "dispatched",
  DELIVERED_UNLOADING: "delivered_unloading",
  MEASURING: "measuring",
  MEASUREMENT_DONE: "measurement_done",
  STRUCTURE_BUILDING: "structure_building",
  STRUCTURE_COMPLETED: "structure_completed",
  INSTALLING: "installing",
  TESTING: "testing",
  COMMISSIONING: "commissioning",
  COMMISSIONED: "commissioned",
  CUSTOMER_SIGNOFF: "customer_signoff",
} as const;
export type StageKey = (typeof STAGE_KEY)[keyof typeof STAGE_KEY];

export const STATUS_OPTION_KEY = {
  PENDING: "pending",
  POSTPONE_TO_TOMORROW: "postpone_to_tomorrow",
  MATERIAL_NOT_ARRIVED: "material_not_arrived",
  AWAITING_SCAFFOLDING_MATERIALS: "awaiting_scaffolding_materials",
  DONE: "done",
} as const;
export type StatusOptionKey = (typeof STATUS_OPTION_KEY)[keyof typeof STATUS_OPTION_KEY];

export const PHOTO_CHECKPOINT_KEY = {
  BEFORE_INSTALLATION: "before_installation",
  MEASURING: "measuring",
  AFTER_INSTALLATION: "after_installation",
} as const;
export type PhotoCheckpointKey = (typeof PHOTO_CHECKPOINT_KEY)[keyof typeof PHOTO_CHECKPOINT_KEY];

export const ROLE_KEY = {
  SUPER_ADMIN: "super_admin",
  OWNER_ADMIN: "owner_admin",
  MANAGEMENT: "management",
  SALES: "sales",
  OPERATIONS_PM: "operations_pm",
  ERECTION_ENGINEER: "erection_engineer",
  COMMISSIONING_ENGINEER: "commissioning_engineer",
  SERVICE_TEAM: "service_team",
  FINANCE: "finance",
  CUSTOMER: "customer",
  /** Field service engineer - works tickets assigned to them. */
  SERVICE_ENGINEER: "service_engineer",
  /** Runs the service desk company-wide (distinct from the region-scoped Regional Manager). */
  SERVICE_MANAGER: "service_manager",
  /** Owns service activity for one or more Regions (see Region / RegionManager). */
  REGIONAL_MANAGER: "regional_manager",
} as const;
export type RoleKey = (typeof ROLE_KEY)[keyof typeof ROLE_KEY];

/** Roles that may knowingly create a second order for the same customer + PO number (enforced by the API; the Orders
 * form uses the same list only to decide whether to show the override checkbox). */
export const PO_DUPLICATE_OVERRIDE_ROLE_KEYS: readonly string[] = [ROLE_KEY.SUPER_ADMIN, ROLE_KEY.OWNER_ADMIN, ROLE_KEY.MANAGEMENT];
export const canOverrideDuplicatePo = (roleKey: string | null | undefined): boolean =>
  !!roleKey && PO_DUPLICATE_OVERRIDE_ROLE_KEYS.includes(roleKey);

export const PERMISSION_KEY = {
  VIEW_SITE_STATUS: "view_site_status",
  CHANGE_SITE_STATUS: "change_site_status",
  VIEW_DASHBOARD: "view_dashboard",
  VIEW_COMPLAINTS_OVERVIEW: "view_complaints_overview",
  MANAGE_COMPLAINTS: "manage_complaints",
  RAISE_COMPLAINT: "raise_complaint",
  MANAGE_ORDERS: "manage_orders",
  MANAGE_USERS: "manage_users",
  RESOLVE_PENDING_ACTION: "resolve_pending_action",
  MANAGE_SETTINGS: "manage_settings",
  /** Act on complaints assigned to you (field engineers resolving their own tickets). */
  ACT_ASSIGNED_COMPLAINTS: "act_assigned_complaints",
  /** Review, approve/reject vendor registrations and assign vendors to sites. */
  MANAGE_VENDORS: "manage_vendors",
  /** Create/view AMC (Annual Maintenance Contract) orders. */
  MANAGE_AMC_ORDERS: "manage_amc_orders",
  /** Create/rename/deactivate Regions and map Regional Managers to them. */
  MANAGE_REGIONS: "manage_regions",
  /** Record and correct the warranty dates of RECD units (Requirement 8). Granted to super_admin, owner_admin and management. */
  MANAGE_WARRANTY: "manage_warranty",
} as const;
export type PermissionKey = (typeof PERMISSION_KEY)[keyof typeof PERMISSION_KEY];

export const NOTIFICATION_CHANNEL = {
  IN_APP: "in_app",
  EMAIL: "email",
  SMS: "sms",
  WHATSAPP: "whatsapp",
  TELEGRAM: "telegram",
} as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL];

/** Channels with a real provider wired up in Phase 1; the rest are stubs that log to NotificationLog. */
export const LIVE_NOTIFICATION_CHANNELS: NotificationChannel[] = [
  NOTIFICATION_CHANNEL.IN_APP,
  NOTIFICATION_CHANNEL.EMAIL,
];

export const PENDING_ACTION_CATEGORY = {
  CUSTOMER_APPROVAL: "customer_approval",
  MATERIAL_SHORTAGE: "material_shortage",
  CUSTOMER_SIGNOFF_PENDING: "customer_signoff_pending",
} as const;
export type PendingActionCategory =
  (typeof PENDING_ACTION_CATEGORY)[keyof typeof PENDING_ACTION_CATEGORY];

export const EXHAUST_HOOKUP_TYPE = {
  REPLACE_EXISTING_SILENCER: "replace_existing_silencer",
  ADD_AFTER_EXISTING_EXHAUST: "add_after_existing_exhaust",
} as const;
export type ExhaustHookupType =
  (typeof EXHAUST_HOOKUP_TYPE)[keyof typeof EXHAUST_HOOKUP_TYPE];

export const COMPLAINT_STATUS = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  WAITING_FOR_CUSTOMER: "waiting_for_customer",
  WAITING_FOR_PART: "waiting_for_part",
  ESCALATED: "escalated",
  RESOLVED: "resolved",
  CLOSED: "closed",
} as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUS)[keyof typeof COMPLAINT_STATUS];

export const COMPLAINT_CATEGORY = {
  ERECTION_COMMISSIONING: "erection_commissioning",
  DELIVERY_DELAY: "delivery_delay",
  NON_PERFORMANCE: "non_performance",
} as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORY)[keyof typeof COMPLAINT_CATEGORY];

export const PRODUCT_SHAPE = {
  CYLINDER: "cylinder",
  TRIANGLE: "triangle",
  RECTANGLE: "rectangle",
} as const;
export type ProductShape = (typeof PRODUCT_SHAPE)[keyof typeof PRODUCT_SHAPE];

/** Seeded rows, not exhaustive - see seed.ts. These are the keys application code branches on. */
export const DOCUMENT_REQUIREMENT_TYPE_KEY = {
  POLICE_VERIFICATION: "police_verification",
  ESIC: "esic",
  INSURANCE: "insurance",
  PPE_KITS: "ppe_kits",
} as const;
export type DocumentRequirementTypeKey =
  (typeof DOCUMENT_REQUIREMENT_TYPE_KEY)[keyof typeof DOCUMENT_REQUIREMENT_TYPE_KEY];

export const DOCUMENT_REQUIREMENT_STATUS = {
  NOT_SUBMITTED: "not_submitted",
  SUBMITTED: "submitted",
  VERIFIED: "verified",
} as const;
export type DocumentRequirementStatus =
  (typeof DOCUMENT_REQUIREMENT_STATUS)[keyof typeof DOCUMENT_REQUIREMENT_STATUS];

export const RECD_DELIVERY_STATUS = {
  PENDING: "pending",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
} as const;
export type RecdDeliveryStatus = (typeof RECD_DELIVERY_STATUS)[keyof typeof RECD_DELIVERY_STATUS];

export const VENDOR_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  /** Was approved and doing real work, now deactivated (e.g. malpractice) - unlike REJECTED
   * (never accepted), an archived vendor's history (sites, complaints) stays fully intact
   * and attributed to it; it just drops out of every active selection (new site assignment,
   * new engineer login). */
  ARCHIVED: "archived",
} as const;
export type VendorStatus = (typeof VENDOR_STATUS)[keyof typeof VENDOR_STATUS];

/** Fine-grained issue picker on the customer complaint form, alongside the broader `category`. */
export const ISSUE_CATEGORY = {
  ALARM_ISSUE: "alarm_issue",
  PRESSURE_SENSOR: "pressure_sensor",
  TEMPERATURE_SENSOR: "temperature_sensor",
  CONTROLLER_HMI_ISSUE: "controller_hmi_issue",
  ELECTRICAL_ISSUE: "electrical_issue",
  PM_SERVICE: "pm_service",
  BREAKDOWN_SERVICE: "breakdown_service",
  SPARE_REPLACEMENT: "spare_replacement",
  INSTALLATION_COMMISSIONING_ISSUE: "installation_commissioning_issue",
  FAULT_CODE: "fault_code",
  ABNORMAL_BACK_PRESSURE: "abnormal_back_pressure",
  OTHER: "other",
} as const;
export type IssueCategory = (typeof ISSUE_CATEGORY)[keyof typeof ISSUE_CATEGORY];

export const ISSUE_CATEGORY_LABELS: Record<string, string> = {
  [ISSUE_CATEGORY.ALARM_ISSUE]: "Alarm Issue",
  [ISSUE_CATEGORY.PRESSURE_SENSOR]: "Pressure Sensor",
  [ISSUE_CATEGORY.TEMPERATURE_SENSOR]: "Temperature Sensor",
  [ISSUE_CATEGORY.CONTROLLER_HMI_ISSUE]: "Controller/HMI Issue",
  [ISSUE_CATEGORY.ELECTRICAL_ISSUE]: "Electrical Issue",
  [ISSUE_CATEGORY.PM_SERVICE]: "PM Service",
  [ISSUE_CATEGORY.BREAKDOWN_SERVICE]: "Breakdown Service",
  [ISSUE_CATEGORY.SPARE_REPLACEMENT]: "Spare Replacement",
  [ISSUE_CATEGORY.INSTALLATION_COMMISSIONING_ISSUE]: "Installation/Commissioning Issue",
  [ISSUE_CATEGORY.FAULT_CODE]: "Fault Code",
  [ISSUE_CATEGORY.ABNORMAL_BACK_PRESSURE]: "Abnormal Back Pressure",
  [ISSUE_CATEGORY.OTHER]: "Other",
};

export const AMC_ORDER_STATUS = {
  YET_TO_START: "yet_to_start",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const;
export type AmcOrderStatus = (typeof AMC_ORDER_STATUS)[keyof typeof AMC_ORDER_STATUS];

export const AMC_TYPE = {
  CAMC: "camc",
  NAMC: "namc",
} as const;
export type AmcType = (typeof AMC_TYPE)[keyof typeof AMC_TYPE];

export const AMC_TYPE_LABELS: Record<string, string> = {
  [AMC_TYPE.CAMC]: "CAMC (Comprehensive)",
  [AMC_TYPE.NAMC]: "NAMC (Non-Comprehensive)",
};

/** RECD unit lifecycle. A unit is one physical RECD; an order can carry several. */
export const RECD_UNIT_STATUS = {
  ACTIVE: "active",
  /** Unit swapped out / scrapped - keeps its serial reserved so it can't be reused. */
  RETIRED: "retired",
} as const;
export type RecdUnitStatus = (typeof RECD_UNIT_STATUS)[keyof typeof RECD_UNIT_STATUS];

/** Who is raising a ticket - the registered customer, or someone further down the chain. */
export const REPORTER_TYPE = {
  CUSTOMER: "customer",
  RESELLER: "reseller",
  RE_RESELLER: "re_reseller",
  OTHER: "other",
} as const;
export type ReporterType = (typeof REPORTER_TYPE)[keyof typeof REPORTER_TYPE];

export const USER_AUDIT_ACTION = {
  CREATED: "created",
  UPDATED: "updated",
  ROLE_CHANGED: "role_changed",
  DEACTIVATED: "deactivated",
  ACTIVATED: "activated",
  PASSWORD_RESET: "password_reset",
  /** The customer / vendor link of an account changed (a role change that cleared one is recorded here too). */
  ASSOCIATION_CHANGED: "association_changed",
  /** A privileged administrative action was REFUSED (never a change): who tried what, and why it was refused. */
  ACTION_DENIED: "action_denied",
  /** The account was deleted (e.g. a customer contact removed with its customer). The trail is kept: see UserAuditLog.targetIdRecorded. */
  DELETED: "deleted",
} as const;
export type UserAuditAction = (typeof USER_AUDIT_ACTION)[keyof typeof USER_AUDIT_ACTION];

/** Where a ticket came from. */
export const COMPLAINT_SOURCE = {
  /** Registered customer logged into the portal. */
  PORTAL: "portal",
  /** Anyone (owner, reseller, re-reseller...) via serial number + mobile + OTP. */
  PUBLIC: "public",
} as const;
export type ComplaintSource = (typeof COMPLAINT_SOURCE)[keyof typeof COMPLAINT_SOURCE];

export const REPORTER_TYPE_LABELS: Record<string, string> = {
  [REPORTER_TYPE.CUSTOMER]: "Owner / end customer",
  [REPORTER_TYPE.RESELLER]: "Reseller",
  [REPORTER_TYPE.RE_RESELLER]: "Re-reseller",
  [REPORTER_TYPE.OTHER]: "Other",
};

/** Public OTP policy - shared so the UI countdowns match the server. */
export const PUBLIC_OTP = {
  CODE_LENGTH: 6,
  EXPIRY_SECONDS: 300,
  RESEND_COOLDOWN_SECONDS: 30,
  MAX_VERIFY_ATTEMPTS: 5,
  SESSION_SECONDS: 900,
} as const;

/**
 * Login OTP policy (customer login and phone-only login) - shared so the server's enforcement and the
 * countdowns/messages in the web and mobile apps cannot disagree.
 */
export const LOGIN_OTP_POLICY = {
  CODE_LENGTH: 6,
  EXPIRY_SECONDS: 600,
  RESEND_COOLDOWN_SECONDS: 30,
  /** Code requests (delivered or not) per user and purpose in any rolling hour. */
  MAX_REQUESTS_PER_HOUR: 5,
  /** Guesses allowed against one code. */
  MAX_ATTEMPTS_PER_CODE: 5,
  /** Guesses allowed per user and purpose in any rolling hour, across ALL codes - requesting a new code does not reset this. */
  MAX_FAILED_PER_HOUR: 10,
} as const;

/** Why a login OTP is issued. A code is only ever accepted for the purpose it was issued for. */
export const LOGIN_OTP_PURPOSE = {
  CUSTOMER_LOGIN: "customer_login",
  PHONE_LOGIN: "phone_login",
} as const;
export type LoginOtpPurpose = (typeof LOGIN_OTP_PURPOSE)[keyof typeof LOGIN_OTP_PURPOSE];

export const COMPLAINT_EVENT = {
  CREATED: "created",
  STATUS_CHANGED: "status_changed",
  ASSIGNED: "assigned",
  ESCALATED: "escalated",
  SERVICE_REPORT_CREATED: "service_report_created",
  SERVICE_REPORT_SUBMITTED: "service_report_submitted",
  SERVICE_REPORT_REOPENED: "service_report_reopened",
  SERVICE_REPORT_SIGNED: "service_report_signed",
  DUE_DATE_SET: "due_date_set",
  /** Notes / remarks / root cause / resolution notes / uploaded report changed (the event names the fields, never the text). */
  NOTES_UPDATED: "notes_updated",
  /** The SLA escalation could not be delivered (no recipient, or every attempt failed): the level was NOT advanced and will be retried. */
  ESCALATION_FAILED: "escalation_failed",
  /** The ticket was archived (removed from working views, nothing deleted). The event records who, when and the optional reason. */
  ARCHIVED: "archived",
  /** An archived ticket was restored to the working views (who, when, the optional reason, the status it came back in). */
  RESTORED: "restored",
} as const;
export type ComplaintEventType = (typeof COMPLAINT_EVENT)[keyof typeof COMPLAINT_EVENT];

/** Default SLA windows (hours since the ticket was raised). Editable in Settings. */
export const SLA_DEFAULTS = { REGIONAL_MANAGER_HOURS: 24, MANAGEMENT_HOURS: 48 } as const;

/** Statuses in which the SLA clock is not escalating: finished, or waiting on the customer. */
export const SLA_PAUSED_STATUSES: string[] = ["resolved", "closed", "waiting_for_customer"];
