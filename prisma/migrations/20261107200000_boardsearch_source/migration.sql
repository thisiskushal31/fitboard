-- A database created from the earlier migrations still has the old source label.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum
    JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
    WHERE pg_type.typname = 'PostingSource' AND pg_enum.enumlabel = 'JSEARCH'
  ) THEN
    ALTER TYPE "PostingSource" RENAME VALUE 'JSEARCH' TO 'BOARDSEARCH';
  END IF;
END $$;

UPDATE "Setting" AS old
SET "key" = 'boardsearchKeyEnc'
WHERE old."key" = 'jsearchKeyEnc'
  AND NOT EXISTS (SELECT 1 FROM "Setting" AS kept WHERE kept."key" = 'boardsearchKeyEnc');

UPDATE "Setting" AS old
SET "key" = 'boardsearchHost'
WHERE old."key" = 'jsearchHost'
  AND NOT EXISTS (SELECT 1 FROM "Setting" AS kept WHERE kept."key" = 'boardsearchHost');

DELETE FROM "Setting" WHERE "key" IN ('jsearchKeyEnc', 'jsearchHost');

UPDATE "Setting"
SET "value" = 'BOARDSEARCH'
WHERE "key" = 'jobSource' AND "value" = 'JSEARCH';
