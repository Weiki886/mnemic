CREATE TABLE IF NOT EXISTS "model_daily_quota" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" bigint NOT NULL,
	CONSTRAINT "model_daily_quota_calls_check" CHECK ("model_daily_quota"."calls" between 1 and 9007199254740991)
);
