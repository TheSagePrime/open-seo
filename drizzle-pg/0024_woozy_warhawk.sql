CREATE TABLE "project_research_cost_history" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"tool" text NOT NULL,
	"provider_category" text NOT NULL,
	"request_size" integer NOT NULL,
	"cache_hit" integer NOT NULL,
	"provider_cost_usd" text,
	"credits_charged" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_research_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"research_type" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_json" text NOT NULL,
	"payload_json" text NOT NULL,
	"source" text,
	"provider_category" text,
	"provider_cost_usd" text,
	"origin" text NOT NULL,
	"researched_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_research_cost_history" ADD CONSTRAINT "project_research_cost_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_snapshots" ADD CONSTRAINT "project_research_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_research_cost_history_project_created_idx" ON "project_research_cost_history" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_research_snapshots_lookup_idx" ON "project_research_snapshots" USING btree ("project_id","research_type","request_hash","researched_at");--> statement-breakpoint
CREATE INDEX "project_research_snapshots_project_researched_idx" ON "project_research_snapshots" USING btree ("project_id","researched_at");