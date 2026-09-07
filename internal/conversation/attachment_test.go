package conversation

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/OnyxAxisOwO/ObsidianArc/internal/config"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/database"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/group"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/user"
)

// A per-file ceiling bounds nothing on its own: uploading is a database write
// any signed-in account can repeat, and six megabytes at a time fills a disk.
// These are the account-level bounds.

func attachmentFixture(t *testing.T) (*Store, *user.Store, user.User) {
	t.Helper()
	ctx := context.Background()

	db, err := database.Open(ctx, config.Database{
		Driver:       "sqlite",
		DSN:          filepath.Join(t.TempDir(), "attachments.db"),
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
	if _, err := groups.Create(ctx, nil, group.CreateInput{Name: "Default", IsDefault: true}); err != nil {
		t.Fatalf("create group: %v", err)
	}
	users := user.NewStore(db)
	account, err := users.Create(ctx, nil, user.CreateInput{
		Username: "uploader", PasswordHash: "not-a-real-hash",
	})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	return NewStore(db), users, account
}

func upload(t *testing.T, store *Store, userID string, size int) error {
	t.Helper()
	_, err := store.Upload(context.Background(), UploadInput{
		UserID: userID,
		Mime:   "image/png",
		Data:   bytes.Repeat([]byte{1}, size),
	})
	return err
}

// DeleteUnsent backs the image studio's reference pictures: a successful
// generation is what consumes the upload, and the delete must reach only
// the rows still waiting for a message.
func TestDeleteUnsentSparesLinkedRows(t *testing.T) {
	store, users, account := attachmentFixture(t)
	ctx := context.Background()

	spent, err := store.Upload(ctx, UploadInput{
		UserID: account.ID, Mime: "image/png", Data: bytes.Repeat([]byte{2}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	kept, err := store.Upload(ctx, UploadInput{
		UserID: account.ID, Mime: "image/png", Data: bytes.Repeat([]byte{3}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}

	// The spent one is linked to a message first, the way a sent turn
	// claims its uploads. The conversation carries no model: the link is
	// what is under test, not the transcript.
	chat, err := store.Create(ctx, nil, account.ID, "chat", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(ctx, nil, AppendInput{
		ConversationID: chat.ID,
		UserID:         account.ID,
		Role:           RoleUser,
		Content:        "look",
		AttachmentIDs:  []string{spent.ID},
	}); err != nil {
		t.Fatal(err)
	}

	other, err := users.Create(ctx, nil, user.CreateInput{
		Username: "someone-else", PasswordHash: "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := store.Upload(ctx, UploadInput{
		UserID: other.ID, Mime: "image/png", Data: bytes.Repeat([]byte{4}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}

	removed, err := store.DeleteUnsent(ctx, account.ID, []string{spent.ID, kept.ID, foreign.ID})
	if err != nil || removed != 1 {
		t.Fatalf("removed %d: %v", removed, err)
	}
	// The linked row survives the delete even though its id was named: a
	// message owns it now, not the composer.
	if _, _, err := store.Blob(ctx, account.ID, spent.ID); err != nil {
		t.Fatalf("took an upload a message already claimed: %v", err)
	}
	if _, _, err := store.Blob(ctx, account.ID, kept.ID); !errors.Is(err, ErrAttachmentNotFound) {
		t.Errorf("the named unsent upload is still readable: %v", err)
	}
	if _, _, err := store.Blob(ctx, other.ID, foreign.ID); err != nil {
		t.Errorf("took someone else's upload by naming its id: %v", err)
	}
}

func TestPendingUploadsAreCapped(t *testing.T) {
	store, _, account := attachmentFixture(t)

	for i := 0; i < MaxPendingAttachments; i++ {
		if err := upload(t, store, account.ID, 32); err != nil {
			t.Fatalf("upload %d of an allowed %d: %v", i+1, MaxPendingAttachments, err)
		}
	}
	if err := upload(t, store, account.ID, 32); err != ErrTooManyPending {
		t.Fatalf("err = %v, want ErrTooManyPending", err)
	}
}

func TestParallelUploadsCannotRacePastThePendingCap(t *testing.T) {
	store, _, account := attachmentFixture(t)

	const attempts = MaxPendingAttachments * 2
	start := make(chan struct{})
	errorsByAttempt := make(chan error, attempts)
	var workers sync.WaitGroup
	for i := 0; i < attempts; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			_, err := store.Upload(context.Background(), UploadInput{
				UserID: account.ID,
				Mime:   "image/png",
				Data:   bytes.Repeat([]byte{1}, 32),
			})
			errorsByAttempt <- err
		}()
	}
	close(start)
	workers.Wait()
	close(errorsByAttempt)

	accepted := 0
	refused := 0
	for err := range errorsByAttempt {
		switch err {
		case nil:
			accepted++
		case ErrTooManyPending:
			refused++
		default:
			t.Fatalf("parallel upload returned %v", err)
		}
	}
	if accepted != MaxPendingAttachments || refused != attempts-MaxPendingAttachments {
		t.Fatalf("accepted %d and refused %d; want %d and %d",
			accepted, refused, MaxPendingAttachments, attempts-MaxPendingAttachments)
	}
}

func TestUploadCapsAreScopedToTheAccount(t *testing.T) {
	store, users, account := attachmentFixture(t)

	for i := 0; i < MaxPendingAttachments; i++ {
		if err := upload(t, store, account.ID, 32); err != nil {
			t.Fatal(err)
		}
	}
	other, err := users.Create(context.Background(), nil, user.CreateInput{
		Username: "another", PasswordHash: "not-a-real-hash",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := upload(t, store, other.ID, 32); err != nil {
		t.Fatalf("one account's uploads blocked another: %v", err)
	}
}

func TestOversizeFileIsStillRefused(t *testing.T) {
	store, _, account := attachmentFixture(t)

	if err := upload(t, store, account.ID, MaxAttachmentBytes+1); err != ErrAttachmentTooLarge {
		t.Fatalf("err = %v, want ErrAttachmentTooLarge", err)
	}
	if err := upload(t, store, account.ID, 0); err != ErrAttachmentTooLarge {
		t.Fatalf("empty upload err = %v, want ErrAttachmentTooLarge", err)
	}
}

func TestUnsupportedTypeIsRefusedBeforeAnythingIsStored(t *testing.T) {
	store, _, account := attachmentFixture(t)

	_, err := store.Upload(context.Background(), UploadInput{
		UserID: account.ID,
		Mime:   "application/zip",
		Data:   []byte{1, 2, 3},
	})
	if err != ErrUnsupportedMedia {
		t.Fatalf("err = %v, want ErrUnsupportedMedia", err)
	}
}
