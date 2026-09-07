import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  composeImagePrompt, generatePayload, projectStudioItems, studioItems, studioDraft, studioBusy,
  studioModelID, studioRatio, studioCount, studioSteps, generateInStudio,
  ensureStudioModel, pendingCard,
} from '../src/chat/useImageStudio';
import { models } from '../src/chat/useModels';
import { imageFileName } from '../src/chat/useAlbum';
import { activeID, busy as chatBusy, messages } from '../src/chat/useChat';
import type { GeneratedImage } from '../src/api/images';
import type { AvailableModel } from '../src/chat/useModels';
import type { Message } from '../src/api/chat';

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
// conversation's messages become the stream, and what a press adopts when it
// lands are this module's — and those are the parts a provider's strict
// images endpoint, or a switch of conversations, will catch if they are wrong.

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

  it('binds the press to its conversation only when there is one', () => {
    const unbound = generatePayload({
      model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 1, steps: 0,
    });
    expect('conversation_id' in unbound).toBe(false);
    const bound = generatePayload({
      model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 1, steps: 0,
      conversation_id: 'c9',
    });
    expect(bound.conversation_id).toBe('c9');
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

// A user message is the prompt, an assistant message with pictures is the
// card, and everything else stays readable as text — this projection is what
// makes switching conversations replay generations instead of losing them.
describe('projectStudioItems', () => {
  const user = (id: string, content: string): Message => ({
    id, seq: 1, role: 'user', content, created_at: 1,
  });
  const answer = (id: string, attachments: Message['attachments'], content = ''): Message => ({
    id, seq: 2, role: 'assistant', content, model_name: 'Drawer', created_at: 2,
    ...(attachments ? { attachments } : {}),
  });
  const picture = { id: 'a1', mime: 'image/png', width: 0, height: 0, size: 10 };

  it('turns a prompt and its pictures into one card', () => {
    const items = projectStudioItems([user('u1', 'a lighthouse'), answer('a1', [picture])]);
    expect(items).toEqual([
      { kind: 'text', id: 'u1', role: 'user', content: 'a lighthouse', created_at: 1 },
      { kind: 'card', id: 'a1', prompt: 'a lighthouse', model_name: 'Drawer', images: [picture], created_at: 2 },
    ]);
  });

  it('keeps plain answers readable as text instead of losing them', () => {
    const items = projectStudioItems([user('u1', 'hello'), answer('a1', undefined, 'hi there')]);
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ kind: 'text', id: 'a1', role: 'assistant', content: 'hi there', created_at: 2 });
  });

  it('drops discarded attachments rather than promising a picture', () => {
    const items = projectStudioItems([
      user('u1', 'a lighthouse'),
      answer('a1', [{ ...picture, discarded: true }], 'the picture is gone'),
    ]);
    expect(items[1]).toEqual({ kind: 'text', id: 'a1', role: 'assistant', content: 'the picture is gone', created_at: 2 });
  });

  it('replays several generations in order with their own prompts', () => {
    const items = projectStudioItems([
      user('u1', 'first'), answer('a1', [picture]),
      { ...user('u2', 'second'), seq: 3 }, { ...answer('a2', [{ ...picture, id: 'a2' }]), seq: 4 },
    ]);
    const cards = items.filter((item) => item.kind === 'card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ prompt: 'first', images: [picture] });
    expect(cards[1]).toMatchObject({ prompt: 'second' });
  });
});

// A press is bound to the conversation it was asked from: the server records
// the turn there, the studio adopts the conversation it answers with, and the
// authoritative messages are read back the way a chat turn ends.
describe('generateInStudio', () => {
  const IMAGE: GeneratedImage = {
    id: 'img1', model_id: 'm1', model_name: 'Drawer', prompt: 'a lighthouse',
    size: '1024x1024', mime: 'image/png', bytes: 10, created_at: 1,
  };
  const RELOADED: Message[] = [
    { id: 'u1', seq: 1, role: 'user', content: 'a lighthouse', created_at: 1 },
    {
      id: 'a1', seq: 2, role: 'assistant', content: '', model_name: 'Drawer', created_at: 2,
      attachments: [{ id: 'att1', mime: 'image/png', width: 0, height: 0, size: 10 }],
    },
  ];

  const json = (body: unknown): Response => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  beforeEach(() => {
    studioDraft.value = '';
    studioBusy.value = false;
    pendingCard.value = null;
    studioRatio.value = '1:1';
    studioCount.value = 1;
    studioSteps.value = 0;
    activeID.value = '';
    messages.value = [];
    chatBusy.value = false;
    models.value = [DRAWER];
    ensureStudioModel();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/images')) return json({ conversation_id: 'c1', images: [IMAGE] });
      if (url.includes('/api/conversations/c1')) return json({ conversation: { id: 'c1' }, messages: RELOADED });
      if (url.includes('/api/conversations')) return json({ conversations: [] });
      return json({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to run without a chosen model', async () => {
    studioModelID.value = '';
    await generateInStudio();
    expect(studioItems.value).toEqual([]);
  });

  it('refuses to run while a generation is already running', async () => {
    studioDraft.value = 'a lighthouse';
    studioBusy.value = true;
    await generateInStudio();
    expect(pendingCard.value).toBeNull();
    studioBusy.value = false;
  });

  it('adopts the recorded conversation and replays the turn from it', async () => {
    studioModelID.value = 'm1';
    studioDraft.value = '  a lighthouse  ';
    await generateInStudio();

    expect(activeID.value).toBe('c1');
    expect(messages.value).toEqual(RELOADED);
    const cards = studioItems.value.filter((item) => item.kind === 'card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ prompt: 'a lighthouse', model_name: 'Drawer', images: RELOADED[1]!.attachments });
    // The prompt has been sent; the composer is cleared for the next one.
    expect(studioDraft.value).toBe('');
    expect(studioBusy.value).toBe(false);
    expect(pendingCard.value).toBeNull();
  });

  it('sends the conversation it was asked from when one is open', async () => {
    studioModelID.value = 'm1';
    studioDraft.value = 'a lighthouse';
    activeID.value = 'c9';
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/images')) {
        body = JSON.parse(String(init?.body ?? '{}'));
        return json({ conversation_id: 'c9', images: [IMAGE] });
      }
      if (url.includes('/api/conversations/c9')) return json({ conversation: { id: 'c9' }, messages: RELOADED });
      if (url.includes('/api/conversations')) return json({ conversations: [] });
      return json({});
    }));

    await generateInStudio();
    expect(body.conversation_id).toBe('c9');
    expect(activeID.value).toBe('c9');
  });

  it('keeps the prompt and clears the working card on a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'quota', message: 'no allowance' } }),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    )));
    studioModelID.value = 'm1';
    studioDraft.value = 'a lighthouse';
    await generateInStudio();

    expect(studioDraft.value).toBe('a lighthouse');
    expect(pendingCard.value).toBeNull();
    expect(studioBusy.value).toBe(false);
    expect(activeID.value).toBe('');
  });
});


