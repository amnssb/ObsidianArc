-- The image toolbox's dedicated ground: a second way for a model to draw,
-- and a gallery for what it produces.
--
-- The first capability (supports_image_output) is chat-embedded pictures --
-- an answer that carries them. This one means the provider exposes the model
-- on a native images endpoint, the protocol family gpt-image-1 lives on and
-- which refuses chat/completions outright. The toolbox lists either and
-- calls each the way it actually works.

ALTER TABLE models ADD COLUMN supports_image_api BOOLEAN NOT NULL DEFAULT FALSE;

-- Generated pictures are not attachments: a generation never joins a
-- conversation, so the transcript's truncation, editing and retention rules
-- do not apply to them. They are their own rows, owned directly by the user
-- who paid for them, with a ceiling checked at insert time.
CREATE TABLE generated_images (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    model_id   TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    size       TEXT NOT NULL DEFAULT '',
    mime       TEXT NOT NULL,
    byte_size  INTEGER NOT NULL,
    data       %BLOB% NOT NULL,
    created_at BIGINT NOT NULL
);

-- The gallery's own query: this user's generations, newest first.
CREATE INDEX ix_generated_images_user ON generated_images (user_id, created_at);
