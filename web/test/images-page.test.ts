import { describe, expect, it } from 'vitest';

import { composeImagePrompt } from '../src/chat/images-page';

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
