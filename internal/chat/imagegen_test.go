package chat

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/OnyxAxisOwO/ObsidianArc/internal/conversation"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/httpx"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/model"
)

// The studio's reference pictures ride the same attachment store as chat
// uploads, but a generation is not a message: nothing may link them to a
// transcript, and a successful generation is what consumes them.

func TestReferenceImagesRideTheChatPathAndAreConsumed(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	// The fixture's model sees pictures but does not draw; this one does
	// both, which is what a studio session needs.
	drawer, err := f.models.Create(ctx, model.CreateInput{
		ProviderID:  f.model.ProviderID,
		ModelID:     "drawer",
		DisplayName: "Drawer",
		Enabled:     true,
		Capabilities: model.Capabilities{
			SupportsStreaming:   true,
			SupportsImages:      true,
			SupportsImageOutput: true,
		},
		Weights: model.Weights{InputToken: 1, OutputToken: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	uploaded, err := f.conversations.Upload(ctx, conversation.UploadInput{
		UserID: f.account.ID, Mime: "image/png", Data: []byte{0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4},
	})
	if err != nil {
		t.Fatal(err)
	}

	// The model answers with a picture, so the generation stores one and the
	// press counts as a success.
	picture := base64.StdEncoding.EncodeToString([]byte{0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9})
	f.upstream.plain(
		`{"choices":[{"message":{"content":"![a](data:image/png;base64,` + picture + `)"}}]}`,
	)

	images, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID:       drawer.ID,
		Prompt:        "make this a watercolour",
		AttachmentIDs: []string{uploaded.ID},
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("stored %d pictures, want 1", len(images))
	}

	// The reference reached the provider as an image part, not only as words.
	sent, _ := f.upstream.lastRequest()["messages"].([]any)
	found := false
	for _, entry := range sent {
		message, _ := entry.(map[string]any)
		parts, ok := message["content"].([]any)
		if !ok {
			continue
		}
		for _, part := range parts {
			block, _ := part.(map[string]any)
			if block["type"] == "image_url" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("the reference image never reached the provider")
	}

	// A successful generation is what consumes the upload...
	if _, _, err := f.conversations.Blob(ctx, f.account.ID, uploaded.ID); !errors.Is(err, conversation.ErrAttachmentNotFound) {
		t.Errorf("the spent reference is still readable: %v", err)
	}
	// ...and nothing was written into any conversation: a generation is not
	// a turn, even when it borrows the turn's front door.
	list, err := f.conversations.List(ctx, f.account.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Errorf("the generation created %d conversations, want 0", len(list))
	}
}

// The steps knob belongs to the self-hosted diffusion endpoints that share
// the images wire format; it must reach them as the reader set it, clamped
// to the ceiling, and never ride along as a zero the endpoint did not ask
// for — the official images API refuses arguments it does not know.
func TestStepsReachTheImagesEndpointClamped(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	endpointModel, err := f.models.Create(ctx, model.CreateInput{
		ProviderID:  f.model.ProviderID,
		ModelID:     "endpoint-only",
		DisplayName: "Endpoint Only",
		Enabled:     true,
		Capabilities: model.Capabilities{
			SupportsStreaming: true,
			SupportsImageAPI:  true,
		},
		Weights: model.Weights{InputToken: 1, OutputToken: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	picture := base64.StdEncoding.EncodeToString([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	f.upstream.plain(`{"data":[{"b64_json":"` + picture + `"}]}`)

	images, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: endpointModel.ID,
		Prompt:  "a lighthouse",
		Steps:   30,
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(images) != 1 {
		t.Fatalf("stored %d pictures, want 1", len(images))
	}
	sent := f.upstream.lastRequest()
	if sent["steps"] != float64(30) {
		t.Errorf("steps = %v, want 30", sent["steps"])
	}

	// Over the ceiling is clamped rather than forwarded: an endpoint that
	// takes steps stops somewhere, and the provider's error would be less
	// honest than the number the interface offered.
	f.upstream.plain(`{"data":[{"b64_json":"` + picture + `"}]}`)
	if _, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: endpointModel.ID, Prompt: "a lighthouse", Steps: 999,
	}); err != nil {
		t.Fatalf("generate: %v", err)
	}
	if sent = f.upstream.lastRequest(); sent["steps"] != float64(MaxGenerationSteps) {
		t.Errorf("clamped steps = %v, want %d", sent["steps"], MaxGenerationSteps)
	}

	// Unset stays unset: zero is the endpoint's own default, and a strict
	// endpoint would answer 400 to a field it does not know.
	f.upstream.plain(`{"data":[{"b64_json":"` + picture + `"}]}`)
	if _, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: endpointModel.ID, Prompt: "a lighthouse",
	}); err != nil {
		t.Fatalf("generate: %v", err)
	}
	if sent = f.upstream.lastRequest(); func() bool { _, ok := sent["steps"]; return ok }() {
		t.Errorf("unset steps reached the provider anyway: %v", sent["steps"])
	}
}

// A chat-embedded picture model has no steps parameter to set, so the
// request is spelled out in words beside the aspect ratio — the same
// translation the other presets already get.
func TestStepsAreSpelledOutOnTheChatPath(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	drawer, err := f.models.Create(ctx, model.CreateInput{
		ProviderID:  f.model.ProviderID,
		ModelID:     "drawer",
		DisplayName: "Drawer",
		Enabled:     true,
		Capabilities: model.Capabilities{
			SupportsStreaming:   true,
			SupportsImageOutput: true,
		},
		Weights: model.Weights{InputToken: 1, OutputToken: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	picture := base64.StdEncoding.EncodeToString([]byte{0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9})
	f.upstream.plain(
		`{"choices":[{"message":{"content":"![a](data:image/png;base64,` + picture + `)"}}]}`,
	)

	if _, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: drawer.ID,
		Prompt:  "a lighthouse",
		Steps:   30,
	}); err != nil {
		t.Fatalf("generate: %v", err)
	}

	if text := chatPromptText(f.upstream.lastRequest()); !strings.Contains(text, "30 steps") {
		t.Errorf("the chat-path prompt never mentioned the steps: %q", text)
	}

	// Without a steps preference the sentence stays out of the prompt; a
	// reader who never touched the control should not see it answered with
	// words they did not ask for.
	f.upstream.plain(
		`{"choices":[{"message":{"content":"![a](data:image/png;base64,` + picture + `)"}}]}`,
	)
	if _, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: drawer.ID,
		Prompt:  "a lighthouse",
	}); err != nil {
		t.Fatalf("generate: %v", err)
	}
	if text := chatPromptText(f.upstream.lastRequest()); strings.Contains(text, "steps") {
		t.Errorf("an unset steps preference still reached the prompt: %q", text)
	}
}

// chatPromptText pulls the words of the first message out of a recorded
// request. Content reaches the wire two ways — a plain string when there are
// no pictures in it, an array of parts when there are — and the assertion
// does not care which one this generation used.
func chatPromptText(request map[string]any) string {
	messages, _ := request["messages"].([]any)
	if len(messages) == 0 {
		return ""
	}
	first, _ := messages[0].(map[string]any)
	switch content := first["content"].(type) {
	case string:
		return content
	case []any:
		for _, part := range content {
			block, _ := part.(map[string]any)
			if text, _ := block["text"].(string); text != "" {
				return text
			}
		}
	}
	return ""
}

// A model that draws only on its provider's images endpoint cannot see a
// reference: the images wire this adapter speaks takes a prompt and nothing
// else. Refusing beats silently dropping the picture the reader attached.
func TestReferenceImagesAreRefusedForEndpointOnlyModels(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	endpointModel, err := f.models.Create(ctx, model.CreateInput{
		ProviderID:  f.model.ProviderID,
		ModelID:     "endpoint-only",
		DisplayName: "Endpoint Only",
		Enabled:     true,
		Capabilities: model.Capabilities{
			SupportsStreaming: true,
			SupportsImageAPI:  true,
		},
		Weights: model.Weights{InputToken: 1, OutputToken: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	uploaded, err := f.conversations.Upload(ctx, conversation.UploadInput{
		UserID: f.account.ID, Mime: "image/png", Data: []byte{1, 2, 3},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID:       endpointModel.ID,
		Prompt:        "with a reference",
		AttachmentIDs: []string{uploaded.ID},
	})
	var httpErr *httpx.Error
	if !errors.As(err, &httpErr) || httpErr.Code != "references_unsupported" {
		t.Fatalf("want references_unsupported, got %v", err)
	}

	// Refused before anything was consumed: the upload is still there to be
	// sent again, on its own or to a model that can read it.
	if _, _, err := f.conversations.Blob(ctx, f.account.ID, uploaded.ID); err != nil {
		t.Errorf("the refused reference was consumed anyway: %v", err)
	}
}
