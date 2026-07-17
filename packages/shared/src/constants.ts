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
} as const;
export type RoleKey = (typeof ROLE_KEY)[keyof typeof ROLE_KEY];

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

export const VENDOR_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
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
