-- CreateTable
CREATE TABLE "saved_view" (
    "saved_view_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "query" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "saved_view_pkey" PRIMARY KEY ("saved_view_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "saved_view_saved_view_id_key" ON "saved_view"("saved_view_id");

-- CreateIndex
CREATE INDEX "saved_view_website_id_idx" ON "saved_view"("website_id");
