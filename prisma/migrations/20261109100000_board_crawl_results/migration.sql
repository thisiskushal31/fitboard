-- CreateTable
CREATE TABLE "BoardCrawlResult" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "company" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "samples" JSONB,
    "detail" TEXT NOT NULL DEFAULT '',
    "keywords" TEXT NOT NULL DEFAULT '',
    "place" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "method" TEXT NOT NULL DEFAULT 'browser',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "crawledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardCrawlResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoardCrawlResult_url_key" ON "BoardCrawlResult"("url");

-- CreateIndex
CREATE INDEX "BoardCrawlResult_status_crawledAt_idx" ON "BoardCrawlResult"("status", "crawledAt");

-- CreateIndex
CREATE INDEX "BoardCrawlResult_resolvedAt_idx" ON "BoardCrawlResult"("resolvedAt");

-- CreateIndex
CREATE INDEX "BoardCrawlResult_crawledAt_idx" ON "BoardCrawlResult"("crawledAt");
