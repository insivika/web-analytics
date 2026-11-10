-- CreateIndex
-- Lets the Trial report look up the first occurrence of an event name with a
-- single index probe instead of scanning the website's whole event history.
CREATE INDEX "website_event_website_id_event_name_created_at_idx" ON "website_event"("website_id", "event_name", "created_at");
