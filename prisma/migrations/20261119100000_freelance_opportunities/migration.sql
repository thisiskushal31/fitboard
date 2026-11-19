-- CreateEnum
CREATE TYPE "FreelanceStatus" AS ENUM ('NEW', 'SAVED', 'CONTACTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FreelanceEngagement" AS ENUM ('CONTRACT', 'PROJECT', 'TEMPORARY');

-- CreateTable
CREATE TABLE "FreelanceOpportunity" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL DEFAULT '',
    "place" TEXT NOT NULL DEFAULT '',
    "remote" BOOLEAN,
    "engagement" "FreelanceEngagement" NOT NULL DEFAULT 'CONTRACT',
    "budget" TEXT NOT NULL DEFAULT '',
    "duration" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "postedAt" TIMESTAMP(3),
    "score" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL,
    "scoredWith" TEXT NOT NULL DEFAULT '',
    "status" "FreelanceStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT NOT NULL DEFAULT '',
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreelanceOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreelanceBlock" (
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreelanceBlock_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreelanceOpportunity_applicationId_key" ON "FreelanceOpportunity"("applicationId");

-- CreateIndex
CREATE INDEX "FreelanceOpportunity_status_score_idx" ON "FreelanceOpportunity"("status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "FreelanceOpportunity_source_externalId_key" ON "FreelanceOpportunity"("source", "externalId");

-- AddForeignKey
ALTER TABLE "FreelanceOpportunity" ADD CONSTRAINT "FreelanceOpportunity_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
