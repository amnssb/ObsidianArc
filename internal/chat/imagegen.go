// The image toolbox's dedicated generation path.
//
// A generation is not a conversation: nothing is appended to a transcript,
// nothing is replayed as history, and the pictures land in the gallery
// rather than beside a message. What it shares with a chat turn is the
// front door — the same model permission, the same spend check, the same
// usage ledger — because "the account spent something on a provider" is one
// fact, whoever asked.

package chat

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/OnyxAxisOwO/ObsidianArc/internal/adapter"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/conversation"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/gallery"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/httpx"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/id"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/model"
	"github.com/OnyxAxisOwO/ObsidianArc/internal/user"
)

// MaxPromptRunes bounds what one generation may ask for. An image prompt has
// no transcript behind it, so it can be far shorter than a chat message.
const MaxPromptRunes = 2000

// MaxImagesPerGeneration caps one press of the button. Endpoints that only
// draw one picture per call answer the rest of n with errors, and the panel
// offers 1, 2 and 4 — so the ceiling matches what the interface offers.
const MaxImagesPerGeneration = 4

// MaxReferenceImages caps how many uploaded pictures one generation may
// carry as reference material. Every one of them is re-sent to the provider
// whole, and a prompt that outnumbers its description stops being a
// description; three covers "this character, this place, this style".
const MaxReferenceImages = 3

// MaxGenerationSteps caps the diffusion-steps knob. Every endpoint family
// that accepts the field stops somewhere between 50 and 150, and a reader
// asking for ten thousand steps is asking the provider to burn an afternoon;
// clamping beats forwarding whatever arrived.
const MaxGenerationSteps = 60

type GenerateRequest struct {
	ModelID string
	Prompt  string
	// One of the toolbox's presets: "1:1", "4:3", "16:9", "3:4", "9:16".
	// Two meanings by path: a real `size` on the images endpoint, and a
	// sentence in the prompt on the chat path.
	Ratio string
	Count int
	// Uploads (via the attachment endpoint) sent along as reference
	// material for the picture. Consumed by the generation, not stored in
	// any conversation.
	AttachmentIDs []string
	// Diffusion sampling steps, when the reader set one. Zero leaves the
	// quality to the endpoint's own default, which is also what keeps the
	// OpenAI images API — which has no such field — working unchanged.
	Steps int
}

// GenerateImages produces one batch of pictures and stores them in the
// account's gallery. The reserve/record discipline mirrors Run: the spend
// check before the provider call, the ledger row after it, whatever the
// outcome.
func (s *Service) GenerateImages(ctx context.Context, actor user.User, req GenerateRequest) ([]gallery.Image, error) {
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return nil, httpx.BadRequest("Describe the picture you want first.")
	}
	if utf8.RuneCountInString(prompt) > MaxPromptRunes {
		return nil, httpx.BadRequest("The description must be %d characters or fewer.", MaxPromptRunes)
	}
	count := req.Count
	if count < 1 {
		count = 1
	}
	if count > MaxImagesPerGeneration {
		count = MaxImagesPerGeneration
	}
	steps := req.Steps
	if steps < 0 {
		steps = 0
	}
	if steps > MaxGenerationSteps {
		steps = MaxGenerationSteps
	}

	// Prepare is the chat turn's own front door, and it takes a TurnRequest —
	// the conversation fields stay empty, which is exactly what a generation
	// is: a turn with no conversation attached.
	turn := TurnRequest{User: actor, ModelID: req.ModelID, Content: prompt}
	resolved, release, err := s.Prepare(ctx, &turn)
	if err != nil {
		return nil, translatePrepareError(err)
	}
	defer release()

	if !resolved.Model.SupportsImageAPI && !resolved.Model.SupportsImageOutput {
		return nil, httpx.ForbiddenCode("not_an_image_model", "That model cannot generate images.")
	}

	refs, refIDs, err := s.loadReferences(ctx, actor.ID, req.AttachmentIDs)
	if err != nil {
		return nil, err
	}

	startedAt := time.Now()
	images, err := s.draw(ctx, actor.ID, resolved, prompt, req.Ratio, count, steps, refs)
	if err != nil {
		s.recordGeneration(ctx, turn, resolved, startedAt, StatusError, err)
		return nil, err
	}
	s.recordGeneration(ctx, turn, resolved, startedAt, StatusOK, nil)

	// The references were spent on this generation. Cleared only on
	// success, so a failed one leaves them in the composer and the reader
	// can adjust the description and send again without re-uploading.
	// Detached, because the request context dies with the browser and the
	// bytes are already on their way to the provider.
	if len(refIDs) > 0 {
		dropCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		if _, err := s.conversations.DeleteUnsent(dropCtx, actor.ID, refIDs); err != nil {
			slog.ErrorContext(dropCtx, "could not remove used reference images",
				"error", err, "user", actor.ID)
		}
	}
	return images, nil
}

// loadReferences reads the pictures the reader attached as reference
// material. The transport has already checked the ids' shape and count;
// what it cannot know is whether each row still exists and still carries
// its bytes — both things that change between the upload and the press of
// the button.
func (s *Service) loadReferences(ctx context.Context, userID string, ids []string) ([]conversation.ImageData, []string, error) {
	if len(ids) == 0 {
		return nil, nil, nil
	}
	if len(ids) > MaxReferenceImages {
		ids = ids[:MaxReferenceImages]
	}
	refs := make([]conversation.ImageData, 0, len(ids))
	for _, attachmentID := range ids {
		mime, data, err := s.conversations.Blob(ctx, userID, attachmentID)
		if err != nil {
			if errors.Is(err, conversation.ErrAttachmentNotFound) ||
				errors.Is(err, conversation.ErrAttachmentDiscarded) {
				return nil, nil, httpx.BadRequest(
					"A reference image could no longer be read. Re-attach it and try again.")
			}
			return nil, nil, err
		}
		refs = append(refs, conversation.ImageData{Mime: mime, Data: data})
	}
	return refs, ids, nil
}

// draw produces the pictures by whichever way the model actually draws: a
// native images endpoint when it has one, its chat answer otherwise.
//
// A generation carrying reference pictures always goes by chat, whatever
// the model's own endpoint could do — the images wire this adapter speaks
// takes a prompt and nothing else, so the references would be silently
// dropped exactly where the reader most expects them to matter.
func (s *Service) draw(ctx context.Context, userID string, resolved model.Resolved, prompt, ratio string, count, steps int, refs []conversation.ImageData) ([]gallery.Image, error) {
	if len(refs) > 0 {
		if !resolved.Model.SupportsImages {
			return nil, httpx.ForbiddenCode("references_unsupported",
				"That model cannot read a reference picture. Send the description without one.")
		}
		return s.drawViaChat(ctx, userID, resolved, prompt, ratio, count, steps, refs)
	}
	if resolved.Model.SupportsImageAPI {
		return s.drawViaImagesEndpoint(ctx, userID, resolved, prompt, ratio, count, steps)
	}
	return s.drawViaChat(ctx, userID, resolved, prompt, ratio, count, steps, nil)
}

func (s *Service) drawViaImagesEndpoint(ctx context.Context, userID string, resolved model.Resolved, prompt, ratio string, count, steps int) ([]gallery.Image, error) {
	pictures, err := s.registry.Images(ctx, resolved.Provider, adapter.ImagesRequest{
		Model:  resolved.Upstream.ModelID,
		Prompt: prompt,
		N:      count,
		Size:   imagesAPISize(ratio),
		Steps:  steps,
	})
	if err != nil {
		return nil, err
	}

	saved := make([]gallery.Image, 0, len(pictures))
	for _, picture := range pictures {
		row, err := s.saveGenerated(ctx, userID, resolved, prompt, ratio, picture.MIME, picture.Data)
		if err != nil {
			// The pictures already stored are kept — they were paid for —
			// and a partial batch is still a success worth showing. Only a
			// batch with nothing in it is a failure.
			if len(saved) > 0 {
				return saved, nil
			}
			return nil, err
		}
		saved = append(saved, row)
	}
	return saved, nil
}

// drawViaChat asks a chat-embedded picture model over chat completions and
// lifts the pictures out of the finished answer — the same extraction the
// transcript path uses. The prose around them is discarded: the toolbox
// shows pictures, and the prompt the reader wrote is recorded on every row.
func (s *Service) drawViaChat(ctx context.Context, userID string, resolved model.Resolved, prompt, ratio string, count, steps int, refs []conversation.ImageData) ([]gallery.Image, error) {
	maxTokens := resolved.Upstream.MaxOutputTokens
	if maxTokens == 0 {
		maxTokens = resolved.Model.MaxOutputTokens
	}

	parts := make([]adapter.Part, 0, 1+len(refs))
	parts = append(parts, adapter.Part{Kind: adapter.PartText, Text: chatImagePrompt(prompt, ratio, count, steps)})
	for _, ref := range refs {
		parts = append(parts, adapter.Part{Kind: adapter.PartImage, MediaType: ref.Mime, Data: ref.Data})
	}

	result, err := s.registry.Chat(ctx, resolved.Provider, adapter.ChatRequest{
		Model:     resolved.Upstream.Spec(),
		Messages:  []adapter.Message{{Role: adapter.RoleUser, Parts: parts}},
		MaxTokens: maxTokens,
		Stream:    false,
	}, nil)
	if err != nil {
		return nil, err
	}

	var produced []gallery.Image
	extractInlineImages(result.Text, func(mime string, data []byte) (string, error) {
		row, err := s.saveGenerated(ctx, userID, resolved, prompt, ratio, mime, data)
		if err != nil {
			return "", err
		}
		produced = append(produced, row)
		return row.ID, nil
	}, count)

	if len(produced) == 0 {
		// The answer is the closest thing to an explanation there is — a
		// model that would not draw usually says why.
		return nil, noPictureError(result.Text)
	}
	return produced, nil
}

func (s *Service) saveGenerated(ctx context.Context, userID string, resolved model.Resolved, prompt, ratio, mime string, data []byte) (gallery.Image, error) {
	return s.gallery.Save(ctx, gallery.Image{
		UserID:    userID,
		ModelID:   resolved.Model.ID,
		ModelName: resolved.Model.DisplayName,
		Prompt:    prompt,
		Size:      ratio,
		MIME:      mime,
	}, data)
}

// recordGeneration puts a generation in the usage ledger, as a turn with no
// conversation and no token counts: the request weight is what an image
// model's row honestly costs, and a failed one still tells the operator
// something was attempted.
func (s *Service) recordGeneration(ctx context.Context, turn TurnRequest, resolved model.Resolved, startedAt time.Time, status Status, err error) {
	if s.OnTurn == nil {
		return
	}
	code := ""
	if err != nil {
		code, _ = Describe(err)
	}
	s.OnTurn(ctx, TurnRecord{
		User:         turn.User,
		Model:        resolved.Model,
		ProviderID:   resolved.Provider.ID,
		ProviderName: resolved.Provider.Name,
		RequestID:    id.New(),
		Credits:      resolved.Model.Credits(adapter.Usage{}),
		Status:       status,
		ErrorCode:    code,
		StartedAt:    startedAt,
		FinishedAt:   time.Now(),
	})
}

// chatImagePrompt is the chat-path prompt: the reader's description with the
// presets spelled out, because a chat model has no size parameter to set.
func chatImagePrompt(prompt, ratio string, count, steps int) string {
	if ratio == "" && count <= 1 && steps <= 0 {
		return prompt
	}
	if ratio == "" {
		ratio = "1:1"
	}
	request := "Image request: aspect ratio " + ratio + ", " + strconv.Itoa(count) + " image(s)."
	if steps > 0 {
		request += " " + strconv.Itoa(steps) + " steps."
	}
	return prompt + "\n\n" + request
}

// imagesAPISize maps the toolbox's ratio presets onto the sizes the images
// endpoint family accepts. OpenAI's image models define exactly these three;
// endpoints that take arbitrary sizes render them fine.
func imagesAPISize(ratio string) string {
	switch ratio {
	case "4:3", "16:9":
		return "1536x1024"
	case "3:4", "9:16":
		return "1024x1536"
	default:
		return "1024x1024"
	}
}

// noPictureError turns a picture-less answer into the error the panel shows.
// The model's own words are the useful part; anything longer than a screen
// is not, and a refusal classifies honestly.
func noPictureError(answer string) error {
	text := strings.TrimSpace(strings.ReplaceAll(answer, "\n", " "))
	message := "The model returned no picture in its answer."
	kind := adapter.ErrorUpstream
	if text != "" {
		runes := []rune(text)
		if len(runes) > 200 {
			text = string(runes[:200]) + "…"
		}
		message = text
		kind = adapter.ErrorRefusal
	}
	return &adapter.Error{Kind: kind, Message: message}
}
