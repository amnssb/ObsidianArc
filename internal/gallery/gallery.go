// Package gallery stores the pictures the image toolbox generates.
//
// They are deliberately not attachments and not messages. A generation never
// joins a conversation — that is the whole point of the toolbox — so it gets
// rows of its own that the transcript's truncation, editing and retention
// rules cannot reach, owned directly by the account that paid for them.
package gallery

import (
	"context"
	"time"

	"github.com/OnyxAxisOwO/ObsidianArc/internal/database"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/httpx"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/id"
)

// MaxBytesPerUser bounds how much generated artwork one account may hold.
// A byte ceiling, not a count, because one 4K render and four hundred icons
// cost the operator the same disk; the shape matches the attachment store's
// ceiling family so neither surface is the odd one out.
const MaxBytesPerUser int64 = 512 * 1024 * 1024

// ListLimit is how many generations the panel shows. Older rows stay until
// the reader deletes them or the ceiling pushes them out — history is the
// point of a gallery, and "page 2" is not worth the moving parts yet.
const ListLimit = 60

// Image is one generated picture. The bytes travel separately, so the
// listing stays a listing instead of a multi-megabyte payload.
type Image struct {
	ID        string `json:"id"`
	UserID    string `json:"-"`
	ModelID   string `json:"model_id"`
	ModelName string `json:"model_name"`
	Prompt    string `json:"prompt"`
	Size      string `json:"size"`
	MIME      string `json:"mime"`
	Bytes     int    `json:"bytes"`
	CreatedAt int64  `json:"created_at"`
}

type Store struct {
	db *database.DB
	// The per-account ceiling, a field rather than the constant so a test
	// can exercise the refusal without writing half a gigabyte.
	ceiling int64
}

func NewStore(db *database.DB) *Store { return &Store{db: db, ceiling: MaxBytesPerUser} }

// Save stores one generated picture, holding the owner's row across the
// check-then-write so two concurrent generations cannot walk an account past
// the ceiling. The same row-lock spelling every per-account invariant here
// uses — a mutex would not cover a second instance.
func (s *Store) Save(ctx context.Context, image Image, data []byte) (Image, error) {
	image.ID = id.New()
	image.Bytes = len(data)
	image.CreatedAt = time.Now().UnixMilli()

	err := s.db.Tx(ctx, func(tx *database.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE users SET updated_at = updated_at WHERE id = ?`, image.UserID); err != nil {
			return err
		}
		var used int64
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(SUM(byte_size), 0) FROM generated_images WHERE user_id = ?`,
			image.UserID).Scan(&used); err != nil {
			return err
		}
		if used+int64(image.Bytes) > s.ceiling {
			return httpx.ForbiddenCode("gallery_full",
				"Your image gallery is full. Delete a few pictures to make room.")
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO generated_images
			 (id, user_id, model_id, model_name, prompt, size, mime, byte_size, data, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			image.ID, image.UserID, image.ModelID, image.ModelName, image.Prompt,
			image.Size, image.MIME, image.Bytes, data, image.CreatedAt)
		return err
	})
	if err != nil {
		return Image{}, err
	}
	return image, nil
}

// List returns this user's generations, newest first, metadata only.
func (s *Store) List(ctx context.Context, userID string) ([]Image, error) {
	rows, err := s.db.Query(ctx, `SELECT id, model_id, model_name, prompt, size, mime, byte_size, created_at
		FROM generated_images WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
		userID, ListLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var images []Image
	for rows.Next() {
		var image Image
		image.UserID = userID
		if err := rows.Scan(&image.ID, &image.ModelID, &image.ModelName, &image.Prompt,
			&image.Size, &image.MIME, &image.Bytes, &image.CreatedAt); err != nil {
			return nil, err
		}
		images = append(images, image)
	}
	return images, rows.Err()
}

// Open reads one picture with its bytes, scoped by owner: an id that belongs
// to someone else is simply not found.
func (s *Store) Open(ctx context.Context, userID, imageID string) (Image, []byte, error) {
	var image Image
	image.UserID = userID
	var data []byte
	err := s.db.QueryRow(ctx, `SELECT model_id, model_name, prompt, size, mime, byte_size, created_at, data
		FROM generated_images WHERE id = ? AND user_id = ?`,
		imageID, userID).Scan(&image.ModelID, &image.ModelName, &image.Prompt,
		&image.Size, &image.MIME, &image.Bytes, &image.CreatedAt, &data)
	if err != nil {
		if database.IsNotFound(err) {
			return Image{}, nil, httpx.NotFound("No such picture.")
		}
		return Image{}, nil, err
	}
	return image, data, nil
}

// Delete removes one picture, scoped by owner the same way Open reads it.
func (s *Store) Delete(ctx context.Context, userID, imageID string) error {
	result, err := s.db.Exec(ctx,
		`DELETE FROM generated_images WHERE id = ? AND user_id = ?`, imageID, userID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return httpx.NotFound("No such picture.")
	}
	return nil
}
