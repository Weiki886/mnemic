CREATE INDEX IF NOT EXISTS "belief_versions_source_observation_id_idx" ON "belief_versions" USING btree ("source_observation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beliefs_subject_attribute_idx" ON "beliefs" USING btree ("subject","attribute");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beliefs_current_version_id_idx" ON "beliefs" USING btree ("current_version_id");