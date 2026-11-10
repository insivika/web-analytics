-- CreateTable
CREATE TABLE "ad_spend" (
    "ad_spend_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "account_id" VARCHAR(50) NOT NULL,
    "campaign_id" VARCHAR(50) NOT NULL,
    "campaign_name" VARCHAR(500),
    "adset_id" VARCHAR(50),
    "adset_name" VARCHAR(500),
    "ad_id" VARCHAR(100) NOT NULL,
    "ad_name" VARCHAR(500),
    "spend" DECIMAL(14,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "spend_usd" DECIMAL(14,4),
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("ad_spend_id")
);

-- CreateTable
CREATE TABLE "fx_rate" (
    "date" DATE NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "usd_rate" DECIMAL(18,8) NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fx_rate_pkey" PRIMARY KEY ("date","currency","source")
);

-- CreateTable
CREATE TABLE "ad_sync_run" (
    "ad_sync_run_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "range_start" DATE,
    "range_end" DATE,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "ad_sync_run_pkey" PRIMARY KEY ("ad_sync_run_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_ad_spend_id_key" ON "ad_spend"("ad_spend_id");

-- CreateIndex
CREATE INDEX "ad_spend_website_id_date_idx" ON "ad_spend"("website_id", "date");

-- CreateIndex
CREATE INDEX "ad_spend_website_id_channel_campaign_id_idx" ON "ad_spend"("website_id", "channel", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_spend_website_id_date_channel_ad_id_key" ON "ad_spend"("website_id", "date", "channel", "ad_id");

-- CreateIndex
CREATE INDEX "fx_rate_currency_date_idx" ON "fx_rate"("currency", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_sync_run_ad_sync_run_id_key" ON "ad_sync_run"("ad_sync_run_id");

-- CreateIndex
CREATE INDEX "ad_sync_run_website_id_source_started_at_idx" ON "ad_sync_run"("website_id", "source", "started_at");

