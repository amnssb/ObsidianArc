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

// The studio reference pictures ride the same attachment store as chat
// uploads, and a generation is a turn: without a conversation named, one is
// started, and the prompt, the reference and the pictures all land in it.

func TestABoundGenerationRecordsItsTurn(t *testing.T) {
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

	result, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID:       drawer.ID,
		Prompt:        "make this a watercolour",
		AttachmentIDs: []string{uploaded.ID},
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(result.Images) != 1 {
		t.Fatalf("stored %d pictures, want 1", len(result.Images))
	}
	if result.ConversationID == "" {
		t.Fatal("a generation without a conversation was not given one")
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

	// The turn is replayable: the prompt is the reader message carrying
	// the reference, and the pictures are the answer attachments.
	messages, err := f.conversations.Messages(ctx, nil, f.account.ID, result.ConversationID)
	if err != nil {
		t.Fatalf("the recorded conversation is gone: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("the turn recorded %d messages, want 2", len(messages))
	}
	question, answer := messages[0], messages[1]
	if question.Role != conversation.RoleUser || question.Content != "make this a watercolour" {
		t.Errorf("the prompt was not recorded as the question: %q / %q", question.Role, question.Content)
	}
	if len(question.Attachments) != 1 || question.Attachments[0].ID != uploaded.ID {
		t.Errorf("the reference did not ride with the prompt: %+v", question.Attachments)
	}
	if answer.Role != conversation.RoleAssistant {
		t.Errorf("the answer role = %q", answer.Role)
	}
	if len(answer.Attachments) != 1 {
		t.Fatalf("the answer carries %d pictures, want 1", len(answer.Attachments))
	}
	if answer.Attachments[0].ID == result.Images[0].ID {
		t.Error("the transcript attachment reuses the gallery id instead of its own row")
	}
	if answer.ModelName != "Drawer" {
		t.Errorf("the answer does not name the model that drew it: %q", answer.ModelName)
	}

	// The gallery keeps its own copy for the album; deleting one surface
	// picture must not reach into the other.
	if _, _, err := f.conversations.Blob(ctx, f.account.ID, answer.Attachments[0].ID); err != nil {
		t.Errorf("the recorded picture is not readable from the transcript: %v", err)
	}
	if _, _, err := f.service.gallery.Open(ctx, f.account.ID, result.Images[0].ID); err != nil {
		t.Errorf("the album copy vanished: %v", err)
	}
}

// A generation asked into an existing conversation appends to it rather than
// starting another one, so drawing twice in a row replays both turns in
// order — and a conversation owned by somebody else is not a home.
func TestABoundGenerationJoinsItsConversation(t *testing.T) {
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
	answer := "{\"choices\":[{\"message\":{\"content\":\"![a](data:image/png;base64," + picture + ")\"}}]}"
	f.upstream.plain(answer)

	first, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: drawer.ID, Prompt: "a lighthouse in a storm",
	})
	if err != nil {
		t.Fatalf("first generate: %v", err)
	}

	f.upstream.plain(answer)
	second, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID:        drawer.ID,
		Prompt:         "the same, at dusk",
		ConversationID: first.ConversationID,
	})
	if err != nil {
		t.Fatalf("second generate: %v", err)
	}
	if second.ConversationID != first.ConversationID {
		t.Fatalf("the second press started conversation %q, want %q", second.ConversationID, first.ConversationID)
	}

	messages, err := f.conversations.Messages(ctx, nil, f.account.ID, first.ConversationID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 4 {
		t.Fatalf("two presses recorded %d messages, want 4", len(messages))
	}
	if messages[2].Content != "the same, at dusk" {
		t.Errorf("the second prompt landed out of order: %q", messages[2].Content)
	}

	// A conversation owned by somebody else is not a home: a stale id from
	// a deleted or foreign conversation is a not-found, never another
	// account history.
	foreign := f.other
	f.upstream.plain(answer)
	_, err = f.service.GenerateImages(ctx, foreign, GenerateRequest{
		ModelID:        drawer.ID,
		Prompt:         "not mine",
		ConversationID: first.ConversationID,
	})
	var httpErr *httpx.Error
	if !errors.As(err, &httpErr) {
		t.Fatalf("a foreign conversation accepted a generation: %v", err)
	}
	if still, _ := f.conversations.Messages(ctx, nil, f.account.ID, first.ConversationID); len(still) != 4 {
		t.Errorf("the refused press changed the conversation anyway: %d messages", len(still))
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

	result, err := f.service.GenerateImages(ctx, f.account, GenerateRequest{
		ModelID: endpointModel.ID,
		Prompt:  "a lighthouse",
		Steps:   30,
	})
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(result.Images) != 1 {
		t.Fatalf("stored %d pictures, want 1", len(result.Images))
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
