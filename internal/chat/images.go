// Lifting generated pictures out of a finished answer.
//
// Image-capable models deliver their pictures inside the chat answer itself,
// as markdown images whose source is a base64 data URL. Left alone that text
// would be stored as the answer — megabytes of base64 that the transcript
// truncates, rendered as a link the reader cannot open. Instead the gateway
// stores each picture through the same attachment store a user's upload
// takes, links it to the assistant message, and takes the blob out of the
// text: the transcript shows the picture, ownership-checked like every other
// attachment.

package chat

import (
	"context"
	"encoding/base64"
	"log/slog"
	"regexp"
	"strings"

	"github.com/OnyxAxisOwO/ObsidianArc/internal/conversation"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/settings"
)

// Only the media types the attachment store accepts. Anything else — an SVG
// can carry script — is not a picture this interface presents as one, so the
// pattern never matches it and the text passes through untouched.
var inlineImageRe = regexp.MustCompile(
	`!\[[^\]\n]*\]\(data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)\)`)

// imageStorer receives one decoded picture. Returning an error keeps that
// image's markdown in the answer, so a store refusal degrades to the text the
// reader would have seen without this module at all.
type imageStorer func(mime string, data []byte) (attachmentID string, err error)

// extractInlineImages finds the data-URL images in a finished answer, stores
// up to max of them, and returns the answer with the stored ones lifted out
// plus their attachment ids in the order stored.
//
// One pass over text that is already complete: the stream has ended, so no
// delta ever carries half a picture, and the rewrite cannot race anything.
func extractInlineImages(text string, store imageStorer, max int) (string, []string) {
	matches := inlineImageRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text, nil
	}

	var out strings.Builder
	var ids []string
	last := 0
	stored := 0
	for _, m := range matches {
		if stored >= max {
			break
		}
		mime := text[m[2]:m[3]]
		payload := text[m[4]:m[5]]

		data, err := base64.StdEncoding.DecodeString(payload)
		if err != nil {
			continue
		}
		id, err := store(mime, data)
		if err != nil {
			continue
		}

		out.WriteString(text[last:m[0]])
		last = m[1]
		ids = append(ids, id)
		stored++
	}
	// Nothing was stored: return the original rather than a copy, so the
	// caller's "did anything change" check is exact.
	if stored == 0 {
		return text, nil
	}
	out.WriteString(text[last:])

	return strings.TrimSpace(out.String()), ids
}

// liftImages stores the inline pictures of one finished answer. A failure to
// store is not a failure of the turn — the answer was paid for and read — so
// a refused picture stays in the text and the reason lands in the log.
func (s *Service) liftImages(ctx context.Context, userID, answer string) (string, []string) {
	// The same ceiling a browser upload is held to, read per request so
	// raising the setting takes effect without a restart.
	ceiling := int64(conversation.MaxAttachmentBytes)
	if configured := s.settings.Int(settings.AttachmentMaxMB, 6); configured > 0 {
		ceiling = int64(configured) * 1024 * 1024
	}

	rewritten, ids := extractInlineImages(answer, func(mime string, data []byte) (string, error) {
		record, err := s.conversations.Upload(ctx, conversation.UploadInput{
			UserID:   userID,
			Mime:     mime,
			Data:     data,
			MaxBytes: ceiling,
		})
		if err != nil {
			return "", err
		}
		return record.ID, nil
	}, conversation.MaxAttachmentsPerMessage)

	if len(ids) > 0 {
		slog.InfoContext(ctx, "stored inline images from an answer", "count", len(ids))
	}
	return rewritten, ids
}
