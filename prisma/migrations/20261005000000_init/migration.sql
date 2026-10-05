-- CreateTable
CREATE TABLE "Instance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT,
    "database" TEXT,
    "secret" TEXT NOT NULL,
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "environment" TEXT NOT NULL DEFAULT 'prod',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "thresholds" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "up" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "version" TEXT,
    "uptimeSec" INTEGER,
    "connUsed" INTEGER,
    "connMax" INTEGER,
    "sizeBytes" BIGINT,
    "memMax" BIGINT,
    "role" TEXT,
    "error" TEXT,

    CONSTRAINT "Check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "instanceId" TEXT,
    "instanceName" TEXT,
    "action" TEXT NOT NULL,
    "params" JSONB,
    "ok" BOOLEAN NOT NULL,
    "result" TEXT,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instance_name_key" ON "Instance"("name");

-- CreateIndex
CREATE INDEX "Instance_type_idx" ON "Instance"("type");

-- CreateIndex
CREATE INDEX "Check_instanceId_at_idx" ON "Check"("instanceId", "at");

-- CreateIndex
CREATE INDEX "Check_at_idx" ON "Check"("at");

-- CreateIndex
CREATE INDEX "Audit_at_idx" ON "Audit"("at");

-- CreateIndex
CREATE INDEX "Audit_instanceId_at_idx" ON "Audit"("instanceId", "at");

-- CreateIndex
CREATE INDEX "AlertEvent_instanceId_kind_resolvedAt_idx" ON "AlertEvent"("instanceId", "kind", "resolvedAt");

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
