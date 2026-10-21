-- Requirement 11: delivery ledger for the ticket-age SLA escalation. ADDITIVE ONLY: one new table; no ticket, event or user row is changed.

-- CreateTable
CREATE TABLE "TicketEscalationDelivery" (
    "id" TEXT NOT NULL,
    "complaintId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "recipientId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEscalationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketEscalationDelivery_complaintId_idx" ON "TicketEscalationDelivery"("complaintId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketEscalationDelivery_complaintId_level_recipientId_key" ON "TicketEscalationDelivery"("complaintId", "level", "recipientId");

-- AddForeignKey
ALTER TABLE "TicketEscalationDelivery" ADD CONSTRAINT "TicketEscalationDelivery_complaintId_fkey" FOREIGN KEY ("complaintId") REFERENCES "Complaint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEscalationDelivery" ADD CONSTRAINT "TicketEscalationDelivery_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the two existing escalation levels, and a sane attempt counter.
ALTER TABLE "TicketEscalationDelivery" ADD CONSTRAINT "TicketEscalationDelivery_level_check" CHECK ("level" IN (1, 2));
ALTER TABLE "TicketEscalationDelivery" ADD CONSTRAINT "TicketEscalationDelivery_attempts_check" CHECK ("attempts" >= 0);

-- Same row-level-security posture as the other new tables (the API connects as the table owner).
ALTER TABLE "TicketEscalationDelivery" ENABLE ROW LEVEL SECURITY;
