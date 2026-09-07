import { describe, expect, it } from 'vitest';

import { composeImagePrompt, generatePayload, imageFileName } from '../src/chat/images-page';
import type { GeneratedImage } from '../src/api/images';

const picture = (mime: string): GeneratedImage => ({
  id: '01HQ',
  model_id: 'm1',
  model_name: 'Model',
  prompt: 'a lighthouse',
  size: '1:1',
  mime,
  bytes: 8,
  created_at: 0,
});

describe('composeImagePrompt', () => {
  it('keeps the description as-is when there are no style notes', () => {
    expect(composeImagePrompt('  a lighthouse in a storm  ')).toBe('a lighthouse in a storm');
  });

  it('appends the style notes after one blank line', () => {
    const text = composeImagePrompt('a cat', 'ink wash, soft light');
    expect(text).toBe('a cat\n\nink wash, soft light');
  });

  it('ignores style notes made only of whitespace', () => {
    expect(composeImagePrompt('a cat', '   ')).toBe('a cat');
  });

  it('trims the description but keeps its own line breaks', () => {
    const text = composeImagePrompt('  a cat\n  on a roof  ');
    expect(text).toBe('a cat\n  on a roof');
  });

  it('produces nothing for an empty description, so the generate press cannot fire', () => {
    expect(composeImagePrompt('   ', 'notes')).toBe('');
    expect(composeImagePrompt('', 'notes')).toBe('');
  });
});

describe('generatePayload', () => {
  const base = { model_id: 'm1', prompt: 'a lighthouse', ratio: '1:1', count: 1 };

  it('carries the steps only when the reader set one', () => {
    expect(generatePayload({ ...base, steps: 30 })).toEqual({ ...base, steps: 30 });
  });

  it('leaves the steps out entirely for auto, because a zero is an argument a strict images endpoint refuses', () => {
    expect(generatePayload({ ...base, steps: 0 })).toEqual(base);
  });

  it('carries reference uploads only when there are any', () => {
    expect(generatePayload({ ...base, steps: 0, attachment_ids: [] })).toEqual(base);
    expect(generatePayload({ ...base, steps: 0, attachment_ids: ['a1'] }))
      .toEqual({ ...base, attachment_ids: ['a1'] });
  });
});

describe('imageFileName', () => {
  it('keeps the extension the bytes actually are', () => {
    expect(imageFileName(picture('image/png'))).toBe('image-01HQ.png');
  });

  it('prefers jpg to jpeg, the spelling every file system already shows', () => {
    expect(imageFileName(picture('image/jpeg'))).toBe('image-01HQ.jpg');
  });

  it('falls back to a plain name when the mime has no subtype', () => {
    expect(imageFileName(picture('image'))).toBe('image-01HQ.png');
  });
});
