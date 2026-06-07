DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'annotation_status') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'annotation_status'::regtype
        AND enumlabel = 'non_business'
    ) THEN
      ALTER TYPE annotation_status ADD VALUE 'non_business';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'annotation_status'::regtype
        AND enumlabel = 'restored'
    ) THEN
      ALTER TYPE annotation_status ADD VALUE 'restored';
    END IF;
  END IF;
END $$;
