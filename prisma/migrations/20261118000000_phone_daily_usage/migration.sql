CREATE TABLE "phone_daily_usage" (
  "userId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "count" INTEGER NOT NULL CHECK ("count" > 0),
  PRIMARY KEY ("userId", "day")
);
