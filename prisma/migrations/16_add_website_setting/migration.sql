-- CreateTable
CREATE TABLE "website_setting" (
    "website_setting_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "website_setting_pkey" PRIMARY KEY ("website_setting_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "website_setting_website_setting_id_key" ON "website_setting"("website_setting_id");

-- CreateIndex
CREATE INDEX "website_setting_website_id_idx" ON "website_setting"("website_id");

-- CreateIndex
CREATE UNIQUE INDEX "website_setting_website_id_key_key" ON "website_setting"("website_id", "key");
