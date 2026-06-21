import { PrismaClient, SitcPhase } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  ROLE_KEY,
  PERMISSION_KEY,
  STAGE_KEY,
  STATUS_OPTION_KEY,
  PHOTO_CHECKPOINT_KEY,
} from "@recd/shared";

const prisma = new PrismaClient();

async function seedPermissions() {
  const permissions = [
    { key: PERMISSION_KEY.VIEW_SITE_STATUS, name: "View site status" },
    { key: PERMISSION_KEY.CHANGE_SITE_STATUS, name: "Change site status" },
    { key: PERMISSION_KEY.VIEW_DASHBOARD, name: "View dashboard" },
    { key: PERMISSION_KEY.VIEW_COMPLAINTS_OVERVIEW, name: "View company-wide complaints overview" },
    { key: PERMISSION_KEY.MANAGE_COMPLAINTS, name: "Manage / resolve complaints" },
    { key: PERMISSION_KEY.RAISE_COMPLAINT, name: "Raise a complaint" },
    { key: PERMISSION_KEY.MANAGE_ORDERS, name: "Create / manage orders" },
    { key: PERMISSION_KEY.MANAGE_USERS, name: "Add users and assign roles" },
    { key: PERMISSION_KEY.RESOLVE_PENDING_ACTION, name: "Resolve a pending action" },
    { key: PERMISSION_KEY.MANAGE_SETTINGS, name: "Manage company settings and theming" },
  ];
  for (const p of permissions) {
    await prisma.permission.upsert({ where: { key: p.key }, update: {}, create: p });
  }
}

const ALL_PERMISSIONS = Object.values(PERMISSION_KEY);

async function seedRoles() {
  const roles: Record<string, { name: string; description: string; permissions: string[] }> = {
    [ROLE_KEY.SUPER_ADMIN]: {
      name: "Super Admin",
      description: "Root-level administrator. Full access to settings, user management, and configuration.",
      permissions: ALL_PERMISSIONS,
    },
    [ROLE_KEY.OWNER_ADMIN]: {
      name: "Owner / Admin",
      description: "Proprietor, Owner, CEO, or CTO. Full standard administrative permissions.",
      permissions: ALL_PERMISSIONS.filter((p) => p !== PERMISSION_KEY.MANAGE_SETTINGS),
    },
    [ROLE_KEY.MANAGEMENT]: {
      name: "Management",
      description: "Senior managers below owner level. Full standard administrative permissions.",
      permissions: ALL_PERMISSIONS.filter((p) => p !== PERMISSION_KEY.MANAGE_SETTINGS),
    },
    [ROLE_KEY.SALES]: {
      name: "Sales",
      description: "Creates orders, views customer project progress.",
      permissions: [PERMISSION_KEY.MANAGE_ORDERS, PERMISSION_KEY.VIEW_SITE_STATUS],
    },
    [ROLE_KEY.OPERATIONS_PM]: {
      name: "Operations / Project Manager",
      description: "Assigns engineers, updates plans, tracks pending items.",
      permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.CHANGE_SITE_STATUS, PERMISSION_KEY.RESOLVE_PENDING_ACTION],
    },
    [ROLE_KEY.ERECTION_ENGINEER]: {
      name: "Erection Engineer",
      description: "Updates site progress on the ground. Oversees all erection-stage field work (fitters/welders are informal titles under this role, not separate roles).",
      permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.CHANGE_SITE_STATUS],
    },
    [ROLE_KEY.COMMISSIONING_ENGINEER]: {
      name: "Commissioning Engineer",
      description: "Updates commissioning stages, uploads test reports.",
      permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.CHANGE_SITE_STATUS],
    },
    [ROLE_KEY.SERVICE_TEAM]: {
      name: "Service Team",
      description: "Handles and resolves customer complaints day to day.",
      permissions: [PERMISSION_KEY.MANAGE_COMPLAINTS, PERMISSION_KEY.VIEW_SITE_STATUS],
    },
    [ROLE_KEY.FINANCE]: {
      name: "Finance",
      description: "Order value, invoicing, payment status - module deferred to Phase 2.",
      permissions: [],
    },
    [ROLE_KEY.CUSTOMER]: {
      name: "Customer",
      description: "Views only their own orders/sites, raises complaints, resolves their own pending actions.",
      permissions: [PERMISSION_KEY.VIEW_SITE_STATUS, PERMISSION_KEY.RAISE_COMPLAINT, PERMISSION_KEY.RESOLVE_PENDING_ACTION],
    },
  };

  for (const [key, def] of Object.entries(roles)) {
    const role = await prisma.role.upsert({
      where: { key },
      update: { name: def.name, description: def.description },
      create: { key, name: def.name, description: def.description },
    });
    for (const permKey of def.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key: permKey } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
}

async function seedStages() {
  const stages: Array<{ key: string; label: string; phase: SitcPhase; sequenceOrder: number }> = [
    { key: STAGE_KEY.ORDER_RECEIVED, label: "Order received", phase: SitcPhase.SUPPLY, sequenceOrder: 1 },
    { key: STAGE_KEY.DISPATCHED, label: "Dispatched", phase: SitcPhase.SUPPLY, sequenceOrder: 2 },
    { key: STAGE_KEY.DELIVERED_UNLOADING, label: "Delivered / unloading", phase: SitcPhase.SUPPLY, sequenceOrder: 3 },
    { key: STAGE_KEY.MEASURING, label: "Measuring", phase: SitcPhase.INSTALLATION, sequenceOrder: 4 },
    { key: STAGE_KEY.MEASUREMENT_DONE, label: "Measurement done", phase: SitcPhase.INSTALLATION, sequenceOrder: 5 },
    { key: STAGE_KEY.STRUCTURE_BUILDING, label: "Building the structure", phase: SitcPhase.INSTALLATION, sequenceOrder: 6 },
    { key: STAGE_KEY.STRUCTURE_COMPLETED, label: "Structure completed", phase: SitcPhase.INSTALLATION, sequenceOrder: 7 },
    { key: STAGE_KEY.INSTALLING, label: "Installing", phase: SitcPhase.INSTALLATION, sequenceOrder: 8 },
    { key: STAGE_KEY.TESTING, label: "Testing", phase: SitcPhase.TESTING, sequenceOrder: 9 },
    { key: STAGE_KEY.COMMISSIONING, label: "Commissioning", phase: SitcPhase.COMMISSIONING, sequenceOrder: 10 },
    { key: STAGE_KEY.COMMISSIONED, label: "Commissioned", phase: SitcPhase.COMMISSIONING, sequenceOrder: 11 },
    { key: STAGE_KEY.CUSTOMER_SIGNOFF, label: "Customer sign-off", phase: SitcPhase.COMMISSIONING, sequenceOrder: 12 },
  ];
  for (const s of stages) {
    await prisma.stageDefinition.upsert({ where: { key: s.key }, update: s, create: s });
  }
}

async function seedStatusOptions() {
  const options = [
    { key: STATUS_OPTION_KEY.PENDING, label: "Pending", sequenceOrder: 1 },
    { key: STATUS_OPTION_KEY.POSTPONE_TO_TOMORROW, label: "Postpone to tomorrow", sequenceOrder: 2 },
    { key: STATUS_OPTION_KEY.MATERIAL_NOT_ARRIVED, label: "Material not arrived (RECD unit)", sequenceOrder: 3 },
    { key: STATUS_OPTION_KEY.AWAITING_SCAFFOLDING_MATERIALS, label: "Awaiting materials for the scaffolding", sequenceOrder: 4 },
    { key: STATUS_OPTION_KEY.DONE, label: "Done", sequenceOrder: 5, requiresComment: false },
  ];
  for (const o of options) {
    await prisma.statusOption.upsert({
      where: { domain_key: { domain: "site_stage", key: o.key } },
      update: o,
      create: { domain: "site_stage", ...o },
    });
  }
}

async function seedPhotoCheckpoints() {
  const checkpoints = [
    { key: PHOTO_CHECKPOINT_KEY.BEFORE_INSTALLATION, label: "Before installation", sequenceOrder: 1 },
    { key: PHOTO_CHECKPOINT_KEY.MEASURING, label: "Measuring", sequenceOrder: 2 },
    { key: PHOTO_CHECKPOINT_KEY.AFTER_INSTALLATION, label: "After installation", sequenceOrder: 3 },
  ];
  for (const c of checkpoints) {
    await prisma.photoCheckpoint.upsert({ where: { key: c.key }, update: c, create: c });
  }
}

async function seedSampleUsers() {
  const passwordHash = await bcrypt.hash("changeme123", 10);
  const roleEntries = await prisma.role.findMany();
  const roleIdByKey = new Map(roleEntries.map((r) => [r.key, r.id]));

  const internalUsers = [
    { name: "Super Admin", email: "superadmin@platino.example", roleKey: ROLE_KEY.SUPER_ADMIN, title: "Super Admin" },
    { name: "Priya Sharma", email: "owner@platino.example", roleKey: ROLE_KEY.MANAGEMENT, title: "Proprietor" },
    { name: "Anil Mehta", email: "management@platino.example", roleKey: ROLE_KEY.MANAGEMENT, title: "Operations Head" },
    { name: "Rahul Verma", email: "sales@platino.example", roleKey: ROLE_KEY.SALES, title: "Sales Engineer" },
    { name: "Sunil Rao", email: "ops@platino.example", roleKey: ROLE_KEY.OPERATIONS_PM, title: "Project Manager" },
    { name: "Vikram Singh", email: "erection@platino.example", roleKey: ROLE_KEY.ERECTION_ENGINEER, title: "Erection Engineer" },
    { name: "Deepak Kumar", email: "commissioning@platino.example", roleKey: ROLE_KEY.COMMISSIONING_ENGINEER, title: "Commissioning Engineer" },
    { name: "Meena Iyer", email: "service@platino.example", roleKey: ROLE_KEY.SERVICE_TEAM, title: "Service Team" },
    { name: "Kavita Nair", email: "finance@platino.example", roleKey: ROLE_KEY.FINANCE, title: "Finance" },
  ];

  for (const u of internalUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        roleId: roleIdByKey.get(u.roleKey)!,
        isActive: true,
        mustChangePassword: false,
      },
      create: {
        name: u.name,
        email: u.email,
        passwordHash,
        title: u.title,
        roleId: roleIdByKey.get(u.roleKey)!,
        isActive: true,
        mustChangePassword: false,
      },
    });
  }

  const customer = await prisma.customer.upsert({
    where: { id: "seed-customer-1" },
    update: {},
    create: {
      id: "seed-customer-1",
      name: "Sundaram Textiles Pvt Ltd",
      address: "Coimbatore, Tamil Nadu",
    },
  });

  await prisma.user.upsert({
    where: { email: "customer@sundaram.example" },
    update: {
      roleId: roleIdByKey.get(ROLE_KEY.CUSTOMER)!,
      isActive: true,
      mustChangePassword: false,
    },
    create: {
      name: "Suresh Sundaram",
      email: "customer@sundaram.example",
      phone: "+919900011122",
      roleId: roleIdByKey.get(ROLE_KEY.CUSTOMER)!,
      customerId: customer.id,
      isActive: true,
      mustChangePassword: false,
    },
  });

  return { customer };
}

async function seedSampleOrder(customerId: string) {
  const product = await prisma.product.upsert({
    where: { model: "RECD-250" },
    update: {},
    create: {
      name: "Platino RECD",
      model: "RECD-250",
      ratingSpec: "Retrofit Emission Control Device for 250 kVA DG sets",
      capacityKva: 250,
      warrantyMonths: 24,
    },
  });

  const salesUser = await prisma.user.findUniqueOrThrow({ where: { email: "sales@platino.example" } });
  const erectionUser = await prisma.user.findUniqueOrThrow({ where: { email: "erection@platino.example" } });
  const firstStage = await prisma.stageDefinition.findUniqueOrThrow({ where: { key: STAGE_KEY.ORDER_RECEIVED } });

  const order = await prisma.order.upsert({
    where: { orderNumber: "ORD-2026-0001" },
    update: {},
    create: {
      orderNumber: "ORD-2026-0001",
      customerId,
      productId: product.id,
      quantity: 1,
      value: 850000,
      orderDate: new Date(),
      salesEngineerId: salesUser.id,
      plannedExhaustHookupType: "replace_existing_silencer",
      site: {
        create: {
          address: "Plot 14, SIPCOT Industrial Estate, Coimbatore",
          assignedEngineerId: erectionUser.id,
          currentStageId: firstStage.id,
          dgCapacityKva: 250,
        },
      },
    },
  });

  return order;
}

async function seedCompanySettings() {
  await prisma.companySettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      themeKey: "emerald",
      logoDataUrl: null,
      customColors: null,
    },
  });
}

async function main() {
  await seedPermissions();
  await seedRoles();
  await seedStages();
  await seedStatusOptions();
  await seedPhotoCheckpoints();
  const { customer } = await seedSampleUsers();
  await seedSampleOrder(customer.id);
  await seedCompanySettings();
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
