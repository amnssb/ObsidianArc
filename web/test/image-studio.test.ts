import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  composeImagePrompt, generatePayload, cards, studioDraft, studioBusy,
  studioModelID, studioRatio, studioCount, studioSteps, generateInStudio,
  ensureStudioModel,
} from '../src/chat/useImageStudio';
import { models } from '../src/chat/useModels';
import { imageFileName } from '../src/chat/useAlbum';
import type { GeneratedImage } from '../src/api/images';
import type { AvailableModel } from '../src/chat/useModels';

/** One drawable model, as /api/models would answer with. */
const DRAWER: AvailableModel = {
  id: 'm1',
  display_name: 'Drawer',
  description: '',
  avatar: '',
  usable: true,
  supports_reasoning: false,
  supports_images: false,
  supports_vision: false,
  supports_streaming: true,
  supports_system_prompt: true,
  supports_tools: false,
  supports_image_output: false,
  supports_image_api: true,
  context_window: 8192,
  max_output_tokens: 4096,
};

// The studio's logic, separate from its surface.
//
// The stream and the composer are Vue's business; what a press sends, how a
// prompt and its style notes become one string, and what a card looks like in
// each state are this module's, and those are the parts a provider's strict
// images endpoint will answer with a 400 if they are wrong.

describe('composeImagePrompt', () => {
  it('passes a plain prompt through', () => {
    expect(composeImagePrompt('a lighthouse in a storm')).toBe('a lighthouse in a storm');
  });

  it('trims whitespace rather than sending it', () => {
    expect(composeImagePrompt('  a lighthouse  ')).toBe('a lighthouse');
  });

  it('joins the style notes as a second paragraph', () => {
    expect(composeImagePrompt('a lighthouse', 'soft light, no text')).toBe(
      'a lighthouse\n\nsoft light, no text',
    );
  });

  it('ignores notes that are only whitespace', () => {
    expect(composeImagePrompt('a lighthouse', '   ')).toBe('a lighthouse');
  });

  it('answers an empty prompt with an empty string', () => {
    expect(composeImagePrompt('   ')).toBe('');
  });
});

describe('generatePayload', () => {
  it('omits the steps field while the preset is auto', () => {
    const payload = generatePayload({
      model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 2, steps: 0,
    });
    expect(payload).toEqual({ model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 2 });
    expect('steps' in payload).toBe(false);
  });

  it('carries the steps field when the reader set one', () => {
    const payload = generatePayload({
      model_id: 'm1', prompt: 'a lighthouse', ratio: '9:16', count: 1, steps: 30,
    });
    expect(payload.steps).toBe(30);
  });

  it('omits empty references rather than sending an empty array', () => {
    const payload = generatePayload({
      model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 1, steps: 0,
      attachment_ids: [],
    });
    expect('attachment_ids' in payload).toBe(false);
  });

  it('carries references when there are any', () => {
    const payload = generatePayload({
      model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 1, steps: 0,
      attachment_ids: ['a1', 'a2'],
    });
    expect(payload.attachment_ids).toEqual(['a1', 'a2']);
  });
});

describe('imageFileName', () => {
  it('names the file after what the bytes actually are', () => {
    const image = { id: 'img1', mime: 'image/png' } as GeneratedImage;
    expect(imageFileName(image)).toBe('image-img1.png');
  });

  it('writes jpg for jpeg', () => {
    const image = { id: 'img1', mime: 'image/jpeg' } as GeneratedImage;
    expect(imageFileName(image)).toBe('image-img1.jpg');
  });
});

describe('generateInStudio', () => {
  const IMAGE: GeneratedImage = {
    id: 'img1', model_id: 'm1', model_name: 'Drawer', prompt: 'a lighthouse',
    size: '1024x1024', mime: 'image/png', bytes: 10, created_at: 1,
  };

  beforeEach(() => {
    studioDraft.value = '';
    cards.value = [];
    studioBusy.value = false;
    studioRatio.value = '1:1';
    studioCount.value = 1;
    studioSteps.value = 0;
    models.value = [DRAWER];
    ensureStudioModel();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/images')) {
        return new Response(JSON.stringify({ images: [IMAGE] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to run without a chosen model', async () => {
    studioModelID.value = '';
    await generateInStudio();
    expect(cards.value).toEqual([]);
  });

  it('refuses to run while a generation is already running', async () => {
    studioModelID.value = 'm1';
    studioDraft.value = 'a lighthouse';
    studioBusy.value = true;
    await generateInStudio();
    expect(cards.value).toEqual([]);
    studioBusy.value = false;
  });

  it('appends one card that finishes done with the returned pictures', async () => {
    studioModelID.value = 'm1';
    studioDraft.value = '  a lighthouse  ';
    await generateInStudio();

    expect(cards.value).toHaveLength(1);
    const card = cards.value[0]!;
    expect(card.prompt).toBe('a lighthouse');
    expect(card.state).toBe('done');
    expect(card.images).toEqual([IMAGE]);
    expect(card.model_name).toBe('Drawer');
    // The prompt has been sent; the composer is cleared for the next one.
    expect(studioDraft.value).toBe('');
    expect(studioBusy.value).toBe(false);
  });

  it('records the failure on the card and keeps the composer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'quota', message: 'no allowance' } }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    )));
    studioModelID.value = 'm1';
    studioDraft.value = 'a lighthouse';
    await generateInStudio();

    const card = cards.value[0]!;
    expect(card.state).toBe('failed');
    expect(card.error).toBe('no allowance');
    // A corrected description can be sent without retyping it.
    expect(studioDraft.value).toBe('a lighthouse');
  });
});
