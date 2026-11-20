-- CreateTable
CREATE TABLE "EventPlace" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "continent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventPlace_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "EventPlace_country_idx" ON "EventPlace"("country");
