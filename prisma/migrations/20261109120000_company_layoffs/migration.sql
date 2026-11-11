-- CreateTable
CREATE TABLE "CompanyLayoff" (
    "id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "normalizedCompany" TEXT NOT NULL,
    "laidOff" INTEGER,
    "percentage" DOUBLE PRECISION,
    "date" TIMESTAMP(3),
    "location" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "industry" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT NOT NULL DEFAULT 'https://layoffs.fyi',
    "rawNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyLayoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyLayoff_normalizedCompany_date_idx" ON "CompanyLayoff"("normalizedCompany", "date");

-- CreateIndex
CREATE INDEX "CompanyLayoff_company_idx" ON "CompanyLayoff"("company");

-- CreateIndex
CREATE INDEX "CompanyLayoff_date_idx" ON "CompanyLayoff"("date");
