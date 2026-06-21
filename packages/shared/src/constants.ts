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
