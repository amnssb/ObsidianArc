// The 生图 studio's state: what the composer holds and what the stream shows.
//
// A module-level store, the way useChat and useModels are. A generation is a
// turn in the conversation it was asked from — the server records the prompt
// and the pictures there — so the stream is not the studio's own list but a
// projection of the open conversation's messages: switching conversations in
// the rail replays both the words and the pictures, and a fresh conversation
// empties the stream, exactly like the chat behaves. The one thing the
// projection cannot show is the press still running, so a working card rides
// alongside until the authoritative reload replaces it.
//
// The presets travel to the server as structured fields (ratio, count), not
// as text baked into the prompt: the backend knows which wire parameter the
// chosen model actually speaks, so the reader never has to.

import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import { uploadAttachment, type AttachmentRef, type Message } from '@/api/chat';
import { generateImages, type GenerateInput } from '@/api/images';
import { t } from '@/composables/useI18n';
import type { StringKey } from '@/i18n';
import { ImageError, prepareImage, type PreparedImage } from './image';
import { activeID, busy as chatBusy, messages, refreshList, reloadActive } from './useChat';
import { models } from './useModels';

/** The ratios the studio offers. Labels are the format itself, not prose. */
export const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;

/** How many pictures one press may ask for. */
export const COUNTS = [1, 2, 4] as const;

/**
 * The diffusion-steps presets. The first entry is the absent one: a model on
 * a provider endpoint that has no such field (or a quality knob of its own)
 * keeps its default, so "auto" is a value the UI shows and the payload omits.
 */
export const STEPS: Array<{ value: number; key: StringKey | null }> = [
  { value: 0, key: 'studioStepsAuto' },
  { value: 20, key: null },
  { value: 30, key: null },
  { value: 40, key: null },
  { value: 50, key: null },
];

/** Reference pictures one generation may carry; the server caps this too. */
export const MAX_REFERENCES = 3;

export const PROMPT_MAX_CHARS = 2000;

export const studioDraft = ref('');
export const studioNotes = ref('');
export const studioRatio = ref<string>(RATIOS[0]);
export const studioCount = ref<number>(COUNTS[0]);
export const studioSteps = ref(0);
export const references = ref<Array<{ attachment: AttachmentRef; preview: string }>>([]);
export const studioBusy = ref(false);
export const studioFlash = ref<{ text: string; error: boolean } | null>(null);

/** The press still running, shown as a working card until the reload lands. */
export const pendingCard = ref<{ prompt: string; model_name: string; ratio: string; count: number } | null>(null);

/** Either way to draw qualifies: a chat answer that carries pictures, or a model the provider exposes on its native images endpoint. */
export const imageModels = computed(() =>
  models.value.filter((model) => (model.supports_image_output || model.supports_image_api) && model.usable !== false),
);

export const studioModelID = ref('');

export const studioModel = computed(
  () => imageModels.value.find((model) => model.id === studioModelID.value) ?? null,
);

/**
 * A model that draws only on its provider's images endpoint cannot look at a
 * picture: the upload button says so instead of failing after the fact.
 */
export function referencesSupported(): boolean {
  const model = studioModel.value;
  return !!model && (model.supports_images || !model.supports_image_api);
}

/** Falls back to the first drawable model when the remembered one is gone. */
export function ensureStudioModel(): void {
  if (!imageModels.value.some((model) => model.id === studioModelID.value)) {
    studioModelID.value = imageModels.value[0]?.id ?? '';
  }
}

/**
 * Joins the reader's description with the optional style notes. Pure and
 * exported for tests: the presets are NOT baked in here — the server maps
 * them onto whatever the chosen model actually speaks.
 */
export function composeImagePrompt(prompt: string, styleNotes?: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return '';
  const notes = (styleNotes ?? '').trim();
  return notes ? trimmed + '\n\n' + notes : trimmed;
}

/**
 * The wire shape of one generate press. Steps, references and the binding
 * conversation ride along only when they were actually set: an absent field
 * is the endpoint's own default, while a zero would arrive as an argument
 * the strict official images API answers with a 400.
 */
export function generatePayload(input: {
  model_id: string;
  prompt: string;
  ratio: string;
  count: number;
  steps: number;
  attachment_ids?: string[];
  conversation_id?: string;
}): GenerateInput {
  return {
    model_id: input.model_id,
    prompt: input.prompt,
    ratio: input.ratio,
    count: input.count,
    ...(input.steps > 0 ? { steps: input.steps } : {}),
    ...(input.attachment_ids?.length ? { attachment_ids: input.attachment_ids } : {}),
    ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
  };
}

/**
 * What the stream shows, projected from the conversation's messages. Pure and
 * exported for tests: a user message is the prompt, an assistant message with
 * pictures is the card, and anything else — plain answers, mixed in when the
 * same conversation carried chat turns too — stays readable as text. The
 * prompt of a card is whatever the reader said just before it, which is also
 * what makes an old generation's card survive a reload with its prompt on it.
 */
export type StudioItem =
  | { kind: 'text'; id: string; role: 'user' | 'assistant'; content: string; created_at: number }
  | { kind: 'card'; id: string; prompt: string; model_name: string; images: AttachmentRef[]; working?: boolean; created_at: number };

export function projectStudioItems(list: readonly Message[]): StudioItem[] {
  const items: StudioItem[] = [];
  let prompt = '';
  for (const message of list) {
    if (message.role === 'user') {
      prompt = message.content;
      if (prompt) {
        items.push({ kind: 'text', id: message.id, role: 'user', content: prompt, created_at: message.created_at });
      }
      continue;
    }
    const images = (message.attachments ?? []).filter((image) => !image.discarded);
    if (images.length) {
      items.push({ kind: 'card', id: message.id, prompt, model_name: message.model_name ?? '', images, created_at: message.created_at });
      prompt = '';
    } else if (message.content) {
      items.push({ kind: 'text', id: message.id, role: 'assistant', content: message.content, created_at: message.created_at });
    }
  }
  return items;
}

/** The stream: the conversation's turns, plus the working card while a press runs. */
export const studioItems = computed<StudioItem[]>(() => {
  const items = projectStudioItems(messages.value);
  if (pendingCard.value) {
    items.push({
      kind: 'card',
      id: 'pending',
      prompt: pendingCard.value.prompt,
      model_name: pendingCard.value.model_name,
      images: [],
      working: true,
      created_at: Date.now(),
    });
  }
  return items;
});

export async function addReferenceFiles(list: FileList | File[] | null): Promise<void> {
  if (studioBusy.value || !referencesSupported()) return;
  const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;

  const room = MAX_REFERENCES - references.value.length;
  if (room <= 0) {
    studioFlash.value = { text: t('tooManyImages', { count: MAX_REFERENCES }), error: true };
    return;
  }

  for (const file of files.slice(0, room)) {
    let prepared: PreparedImage;
    try {
      prepared = await prepareImage(file);
    } catch (error) {
      studioFlash.value = { text: error instanceof ImageError ? error.message : t('imageFailed'), error: true };
      continue;
    }
    try {
      const { attachment } = await uploadAttachment({
        mime: prepared.mime,
        data: prepared.data,
        width: prepared.width,
        height: prepared.height,
      });
      references.value = [...references.value, { attachment, preview: prepared.previewURL }];
    } catch (error) {
      URL.revokeObjectURL(prepared.previewURL);
      studioFlash.value = { text: error instanceof ApiError ? error.message : t('imageFailed'), error: true };
    }
  }
}

export function removeReference(index: number): void {
  const entry = references.value[index];
  if (!entry) return;
  URL.revokeObjectURL(entry.preview);
  references.value = references.value.filter((_, i) => i !== index);
}

export function clearReferences(): void {
  for (const entry of references.value) URL.revokeObjectURL(entry.preview);
  references.value = [];
}

export async function generateInStudio(): Promise<void> {
  if (studioBusy.value || chatBusy.value || !studioModelID.value) return;
  const prompt = composeImagePrompt(studioDraft.value, studioNotes.value);
  if (!prompt) return;

  const model = studioModel.value;
  pendingCard.value = { prompt, model_name: model?.display_name ?? '', ratio: studioRatio.value, count: studioCount.value };
  studioBusy.value = true;
  studioFlash.value = null;
  try {
    const result = await generateImages(generatePayload({
      model_id: studioModelID.value,
      prompt,
      ratio: studioRatio.value,
      count: studioCount.value,
      steps: studioSteps.value,
      // Bind the press to the conversation it was asked from. An empty id
      // means the server starts one and answers with it, which is how a
      // first press gets a home in the rail.
      ...(activeID.value ? { conversation_id: activeID.value } : {}),
      ...(references.value.length ? { attachment_ids: references.value.map((entry) => entry.attachment.id) } : {}),
    }));
    studioDraft.value = '';
    // The server linked the references to the recorded prompt on success; a
    // failure keeps them so a corrected description can be sent without
    // re-uploading.
    clearReferences();
    studioFlash.value = { text: t('studioNote'), error: false };
    // The server owns the transcript: adopt the conversation it recorded the
    // turn in — a new one on a first press — and read the authoritative
    // messages back, exactly the way a chat turn ends.
    if (result.conversation_id && result.conversation_id !== activeID.value) {
      activeID.value = result.conversation_id;
    }
    await reloadActive();
    void refreshList();
  } catch (error) {
    const message = error instanceof ApiError ? error.message : String(error);
    studioFlash.value = { text: t('toolboxFailed', { message }), error: true };
  } finally {
    pendingCard.value = null;
    studioBusy.value = false;
  }
}




