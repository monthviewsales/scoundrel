-- 008: add rating to sc_targets

ALTER TABLE sc_targets
  ADD COLUMN rating TEXT;
