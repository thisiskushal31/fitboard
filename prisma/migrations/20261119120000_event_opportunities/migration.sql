-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('NEW', 'SAVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "EventFormat" AS ENUM ('IN_PERSON', 'VIRTUAL', 'HYBRID', 'UNKNOWN');

-- CreateTable
CREATE TABLE "EventOpportunity" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "place" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "remote" BOOLEAN,
    "format" "EventFormat" NOT NULL DEFAULT 'UNKNOWN',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "ticketPrice" TEXT NOT NULL DEFAULT '',
    "speakers" JSONB NOT NULL,
    "attendance" INTEGER,
    "audience" TEXT NOT NULL DEFAULT '',
    "score" INTEGER NOT NULL DEFAULT 0,
    "proximity" INTEGER NOT NULL DEFAULT 3,
    "reasons" JSONB NOT NULL,
    "scoredWith" TEXT NOT NULL DEFAULT '',
    "status" "EventStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT NOT NULL DEFAULT '',
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventBlock" (
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventBlock_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "EventOpportunity_status_proximity_score_idx" ON "EventOpportunity"("status", "proximity", "score");

-- CreateIndex
CREATE INDEX "EventOpportunity_status_startsAt_idx" ON "EventOpportunity"("status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventOpportunity_source_externalId_key" ON "EventOpportunity"("source", "externalId");
