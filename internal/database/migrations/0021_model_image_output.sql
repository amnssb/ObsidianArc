-- The image toolbox lists models whose answers carry pictures.
--
-- A chat answer is the only path an image takes here — there is no separate
-- generation endpoint — so the flag names what the model does, not what some
-- other URL accepts. The gateway uses it to decide whether to lift the
-- pictures out of a finished answer and store them as attachments.
ALTER TABLE models ADD COLUMN supports_image_output BOOLEAN NOT NULL DEFAULT FALSE;
