package chat

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func pngPayload(t *testing.T) []byte {
	t.Helper()
	// A hand-built payload is fine: the extractor only decodes and forwards,
	// never interprets the bytes.
	return []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3}
}

func TestExtractInlineImagesStoresAndLifts(t *testing.T) {
	data := pngPayload(t)
	answer := "Here is your picture:\n\n![](data:image/png;base64," + base64.StdEncoding.EncodeToString(data) + ")\n\nHope it helps."

	var gotMime string
	var gotData []byte
	rewritten, ids := extractInlineImages(answer, func(mime string, blob []byte) (string, error) {
		gotMime = mime
		gotData = blob
		return "att01", nil
	}, 6)

	if len(ids) != 1 || ids[0] != "att01" {
		t.Fatalf("ids = %v, want [att01]", ids)
	}
	if gotMime != "image/png" {
		t.Errorf("mime = %q, want image/png", gotMime)
	}
	if string(gotData) != string(data) {
		t.Errorf("data not forwarded intact")
	}
	if strings.Contains(rewritten, "base64") || strings.Contains(rewritten, "data:image") {
		t.Errorf("rewritten answer still carries the blob: %q", rewritten)
	}
	for _, want := range []string{"Here is your picture:", "Hope it helps."} {
		if !strings.Contains(rewritten, want) {
			t.Errorf("rewritten answer lost prose %q: %q", want, rewritten)
		}
	}
}

func TestExtractInlineImagesRespectsCap(t *testing.T) {
	data := pngPayload(t)
	one := "![](data:image/png;base64," + base64.StdEncoding.EncodeToString(data) + ")"
	answer := strings.Repeat(one, 8)

	count := 0
	rewritten, ids := extractInlineImages(answer, func(string, []byte) (string, error) {
		count++
		return "att", nil
	}, 6)

	if len(ids) != 6 || count != 6 {
		t.Fatalf("stored %d, want 6", count)
	}
	// The two pictures past the cap keep their markdown: they are visible as
	// links rather than silently dropped.
	if got := strings.Count(rewritten, "data:image/png"); got != 2 {
		t.Errorf("rewritten keeps %d unlifted images, want 2", got)
	}
}

func TestExtractInlineImagesKeepsRefusedPictures(t *testing.T) {
	data := pngPayload(t)
	answer := "![](data:image/png;base64," + base64.StdEncoding.EncodeToString(data) + ")"

	rewritten, ids := extractInlineImages(answer, func(string, []byte) (string, error) {
		return "", errors.New("too large")
	}, 6)

	if len(ids) != 0 {
		t.Fatalf("ids = %v, want none", ids)
	}
	if rewritten != answer {
		t.Errorf("refused picture was lifted anyway: %q", rewritten)
	}
}

func TestExtractInlineImagesLeavesPlainTextAlone(t *testing.T) {
	cases := []string{
		"",
		"just words",
		"![linked](https://example.com/pic.png)",
		// An SVG is not one of the accepted media types and must not match.
		"![](data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte("<svg/>")) + ")",
		// Broken base64 does not match the alphabet, let alone decode.
		"![](data:image/png;base64,not!!valid**base64)",
	}
	for _, text := range cases {
		rewritten, ids := extractInlineImages(text, func(string, []byte) (string, error) {
			return "att", nil
		}, 6)
		if rewritten != text || len(ids) != 0 {
			t.Errorf("extract(%q) = (%q, %v), want unchanged", text, rewritten, ids)
		}
	}
}

func TestExtractInlineImagesDecodesAlongsideBadSiblings(t *testing.T) {
	good := base64.StdEncoding.EncodeToString(pngPayload(t))
	answer := "![](data:image/jpeg;base64,!!broken!!) then ![](data:image/jpeg;base64," + good + ")"

	var stored []byte
	rewritten, ids := extractInlineImages(answer, func(mime string, data []byte) (string, error) {
		stored = data
		return "att-ok", nil
	}, 6)

	if len(ids) != 1 || ids[0] != "att-ok" {
		t.Fatalf("ids = %v, want the one good image", ids)
	}
	if len(stored) == 0 {
		t.Error("good image was not forwarded")
	}
	// The broken one stays as its markdown; the good one is gone.
	if !strings.Contains(rewritten, "!!broken!!") || strings.Contains(rewritten, good) {
		t.Errorf("rewritten = %q", rewritten)
	}
}
