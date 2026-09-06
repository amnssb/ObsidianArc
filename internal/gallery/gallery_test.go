package gallery

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/OnyxAxisOwO/ObsidianArc/internal/config"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/database"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/group"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/httpx"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/user"
)

func newStore(t *testing.T) (*Store, string, string) {
	t.Helper()
	ctx := context.Background()

	db, err := database.Open(ctx, config.Database{
		Driver:       "sqlite",
		DSN:          filepath.Join(t.TempDir(), "gallery.db"),
		MaxOpenConns: 4,
		MaxIdleConns: 2,
	})
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	groups := group.NewStore(db)
	openGroup, err := groups.Create(ctx, nil, group.CreateInput{Name: "Open", IsDefault: true, AllowAllModels: true})
	if err != nil {
		t.Fatal(err)
	}

	users := user.NewStore(db)
	owner, err := users.Create(ctx, nil, user.CreateInput{
		Username: "owner", PasswordHash: "x", GroupID: openGroup.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := users.Create(ctx, nil, user.CreateInput{
		Username: "someone-else", PasswordHash: "x", GroupID: openGroup.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewStore(db), owner.ID, other.ID
}

func TestSaveListOpenDelete(t *testing.T) {
	store, owner, _ := newStore(t)
	ctx := context.Background()

	saved, err := store.Save(ctx, Image{
		UserID: owner, ModelID: "m1", ModelName: "Painter",
		Prompt: "a lighthouse", Size: "16:9", MIME: "image/png",
	}, []byte("png-bytes"))
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if saved.ID == "" || saved.Bytes != len("png-bytes") {
		t.Fatalf("unexpected saved row: %+v", saved)
	}

	list, err := store.List(ctx, owner)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v (%d rows)", err, len(list))
	}

	opened, data, err := store.Open(ctx, owner, saved.ID)
	if err != nil || string(data) != "png-bytes" || opened.Prompt != "a lighthouse" {
		t.Fatalf("open: %v (%q, %+v)", err, data, opened)
	}

	if err := store.Delete(ctx, owner, saved.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, _, err := store.Open(ctx, owner, saved.ID); err == nil {
		t.Fatal("opened a deleted picture")
	}
}

// A gallery is private: an id that belongs to someone else is not found,
// whatever the caller claims.
func TestOtherUserCannotOpenOrDelete(t *testing.T) {
	store, owner, other := newStore(t)
	ctx := context.Background()

	saved, err := store.Save(ctx, Image{
		UserID: owner, ModelName: "Painter", Prompt: "x", MIME: "image/png",
	}, []byte("png-bytes"))
	if err != nil {
		t.Fatal(err)
	}

	if _, _, err := store.Open(ctx, other, saved.ID); err == nil {
		t.Fatal("another account opened a picture it does not own")
	}
	if err := store.Delete(ctx, other, saved.ID); err == nil {
		t.Fatal("another account deleted a picture it does not own")
	}
	if list, err := store.List(ctx, other); err != nil || len(list) != 0 {
		t.Fatalf("another account saw %d pictures", len(list))
	}
}

func TestByteCeilingIsEnforced(t *testing.T) {
	s, owner, _ := newStore(t)
	ctx := context.Background()
	// A tiny ceiling exercises the refusal without writing half a gigabyte.
	store := &Store{db: s.db, ceiling: 64}

	// Exactly the ceiling fits.
	if _, err := store.Save(ctx, Image{
		UserID: owner, ModelName: "Painter", Prompt: "full", MIME: "image/png",
	}, make([]byte, 64)); err != nil {
		t.Fatalf("save at ceiling: %v", err)
	}
	// One more byte does not — and the error is the panel's own refusal.
	_, err := store.Save(ctx, Image{
		UserID: owner, ModelName: "Painter", Prompt: "one more", MIME: "image/png",
	}, []byte("x"))
	var httpErr *httpx.Error
	if !errors.As(err, &httpErr) || httpErr.Code != "gallery_full" {
		t.Fatalf("expected gallery_full, got %v", err)
	}
}
