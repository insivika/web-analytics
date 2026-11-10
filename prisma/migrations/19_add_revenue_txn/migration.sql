-- CreateTable
CREATE TABLE "revenue_txn" (
    "revenue_txn_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "external_id" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "user_id" VARCHAR(100),
    "customer_ref" VARCHAR(200),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(14,4) NOT NULL,
    "gross_usd" DECIMAL(14,4),
    "fee_usd" DECIMAL(14,4),
    "net_usd" DECIMAL(14,4),
    "product" VARCHAR(200),
    "refunded" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_txn_pkey" PRIMARY KEY ("revenue_txn_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_txn_revenue_txn_id_key" ON "revenue_txn"("revenue_txn_id");

-- CreateIndex
CREATE INDEX "revenue_txn_website_id_occurred_at_idx" ON "revenue_txn"("website_id", "occurred_at");

-- CreateIndex
CREATE INDEX "revenue_txn_website_id_user_id_idx" ON "revenue_txn"("website_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_txn_website_id_source_external_id_key" ON "revenue_txn"("website_id", "source", "external_id");

