-- CreateTable
CREATE TABLE "conversion_forecast_snapshot" (
    "conversion_forecast_snapshot_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "model" VARCHAR(40) NOT NULL,
    "users" INTEGER NOT NULL,
    "expected_7" DECIMAL(10,4) NOT NULL,
    "low_7" DECIMAL(10,4) NOT NULL,
    "high_7" DECIMAL(10,4) NOT NULL,
    "expected_14" DECIMAL(10,4) NOT NULL,
    "low_14" DECIMAL(10,4) NOT NULL,
    "high_14" DECIMAL(10,4) NOT NULL,
    "revenue_7" DECIMAL(14,4) NOT NULL,
    "revenue_14" DECIMAL(14,4) NOT NULL,
    "backtest" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversion_forecast_snapshot_pkey" PRIMARY KEY ("conversion_forecast_snapshot_id")
);

-- CreateTable
CREATE TABLE "conversion_forecast_user_snapshot" (
    "conversion_forecast_user_snapshot_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "user_id" VARCHAR(100) NOT NULL,
    "platform" VARCHAR(20),
    "trial_start" TIMESTAMPTZ(6) NOT NULL,
    "elapsed_days" DECIMAL(8,3) NOT NULL,
    "segment" VARCHAR(40) NOT NULL,
    "p_total" DECIMAL(6,5) NOT NULL,
    "p_7" DECIMAL(6,5) NOT NULL,
    "p_14" DECIMAL(6,5) NOT NULL,
    "outcome" BOOLEAN,
    "converted_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "conversion_forecast_user_snapshot_pkey" PRIMARY KEY ("conversion_forecast_user_snapshot_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversion_forecast_snapshot_conversion_forecast_snapshot_id_key" ON "conversion_forecast_snapshot"("conversion_forecast_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_forecast_snapshot_website_id_snapshot_date_key" ON "conversion_forecast_snapshot"("website_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_forecast_user_snapshot_conversion_forecast_user__key" ON "conversion_forecast_user_snapshot"("conversion_forecast_user_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversion_forecast_user_snapshot_website_id_snapshot_date__key" ON "conversion_forecast_user_snapshot"("website_id", "snapshot_date", "user_id");

-- CreateIndex
CREATE INDEX "conversion_forecast_user_snapshot_website_id_outcome_idx" ON "conversion_forecast_user_snapshot"("website_id", "outcome");

