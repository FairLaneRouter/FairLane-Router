CREATE TYPE "public"."attribution_basis" AS ENUM('tip', 'priority-fee', 'ambiguous', 'none');--> statement-breakpoint
CREATE TYPE "public"."comparison_status" AS ENUM('pending', 'complete', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recommendation_mode" AS ENUM('cheap', 'fast');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "channel_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"member_names" text[] NOT NULL,
	"is_sendable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"name" text NOT NULL,
	"tip_accounts" text[] NOT NULL,
	"is_observed" boolean DEFAULT true NOT NULL,
	"is_sendable" boolean DEFAULT false NOT NULL,
	"endpoint_env_key" text,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "comparison_status" DEFAULT 'pending' NOT NULL,
	"naive_signature" text,
	"routed_signature" text,
	"naive_cost" bigint,
	"routed_cost" bigint,
	"naive_landed" boolean,
	"routed_landed" boolean,
	"spend_lamports" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_budget" (
	"day" text PRIMARY KEY NOT NULL,
	"spent_lamports" bigint DEFAULT 0 NOT NULL,
	"runs_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_hourly" (
	"group_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"landings_count" integer NOT NULL,
	"cost_p10" bigint NOT NULL,
	"cost_p50" bigint NOT NULL,
	"cost_p90" bigint NOT NULL,
	"overpay_p50" bigint,
	"share" double precision NOT NULL,
	"unattributed_share" double precision NOT NULL,
	CONSTRAINT "group_hourly_group_id_hour_pk" PRIMARY KEY("group_id","hour")
);
--> statement-breakpoint
CREATE TABLE "indexer_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_slot" bigint NOT NULL,
	"to_slot" bigint NOT NULL,
	"reason" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"healed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "key_usage" (
	"key_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "key_usage_key_id_hour_pk" PRIMARY KEY("key_id","hour")
);
--> statement-breakpoint
CREATE TABLE "landings" (
	"signature" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"base_fee" bigint NOT NULL,
	"priority_fee" bigint NOT NULL,
	"tip_total" bigint NOT NULL,
	"total_cost" bigint NOT NULL,
	"cu_consumed" integer,
	"group_id" text,
	"attribution_basis" "attribution_basis" NOT NULL,
	"overpay" bigint,
	"fee_payer" text NOT NULL,
	"program_ids" text[] NOT NULL,
	"is_sampled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" "recommendation_mode" NOT NULL,
	"group_id" text NOT NULL,
	"tip_lamports" bigint NOT NULL,
	"priority_fee" bigint NOT NULL,
	"expected_cost" bigint NOT NULL,
	"data_age_ms" integer NOT NULL,
	"was_stale" boolean DEFAULT false NOT NULL,
	"landed_signature" text
);
--> statement-breakpoint
CREATE TABLE "slot_refs" (
	"slot" bigint PRIMARY KEY NOT NULL,
	"ref_lamports" bigint NOT NULL,
	"sample_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_group_id_channel_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_hourly" ADD CONSTRAINT "group_hourly_group_id_channel_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_usage" ADD CONSTRAINT "key_usage_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landings" ADD CONSTRAINT "landings_group_id_channel_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_group_id_channel_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_hourly_hour_idx" ON "group_hourly" USING btree ("hour");--> statement-breakpoint
CREATE INDEX "indexer_gaps_open_idx" ON "indexer_gaps" USING btree ("healed_at","from_slot");--> statement-breakpoint
CREATE INDEX "landings_slot_idx" ON "landings" USING btree ("slot");--> statement-breakpoint
CREATE INDEX "landings_group_time_idx" ON "landings" USING btree ("group_id","block_time");--> statement-breakpoint
CREATE INDEX "landings_payer_time_idx" ON "landings" USING btree ("fee_payer","block_time");--> statement-breakpoint
CREATE INDEX "landings_created_at_idx" ON "landings" USING btree ("created_at");