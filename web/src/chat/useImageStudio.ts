// The 生图 studio's state: what the composer holds and what the stream shows.
//
// A module-level store, the way useChat and useModels are. A generation is a
// card in the stream, not a row in a grid: each press appends one card that
// starts working and finishes done or failed, and the composer's references
// ride along only when they were actually uploaded — the server consumes them
// on success, so a corrected description can be sent without re-uploading.
//
// The presets travel to the server as structured fields (ratio, count), not
// as text baked into the prompt: the backend knows which wire parameter the
// chosen model actually speaks, so the reader never has to.

import { computed, ref } from 'vue';
import { ApiError } from '@/api/client';
import { uploadAttachment, type AttachmentRef } from '@/api/chat';
import { generateImages, type GeneratedImage, type GenerateInput } from '@/api/images';
import { t } from '@/composables/useI18n';
import type { StringKey } from '@/i18n';
import { ImageError, prepareImage, type PreparedImage } from './image';
import { models } from './useModels';

/** One generation in the stream, in whichever state it currently is. */
export interface StudioCard {
  id: string;
  prompt: string;
  model_name: string;
  ratio: string;
  count: number;
  state: 'working' | 'done' | 'failed';
  images: GeneratedImage[];
  error?: string;
  created_at: number;
}

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
export const cards = ref<StudioCard[]>([]);
export const studioBusy = ref(false);
export const studioFlash = ref<{ text: string; error: boolean } | null>(null);

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
 * The wire shape of one generate press. Steps and references ride along only
 * when they were actually set: an absent field is the endpoint's own default,
 * while a zero would arrive as an argument the strict official images API
 * answers with a 400.
 */
export function generatePayload(input: {
  model_id: string;
  prompt: string;
  ratio: string;
  count: number;
  steps: number;
  attachment_ids?: string[];
}): GenerateInput {
  return {
    model_id: input.model_id,
    prompt: input.prompt,
    ratio: input.ratio,
    count: input.count,
    ...(input.steps > 0 ? { steps: input.steps } : {}),
    ...(input.attachment_ids?.length ? { attachment_ids: input.attachment_ids } : {}),
  };
}

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

let cardSeq = 0;

export async function generateInStudio(): Promise<void> {
  if (studioBusy.value || !studioModelID.value) return;
  const prompt = composeImagePrompt(studioDraft.value, studioNotes.value);
  if (!prompt) return;

  const model = studioModel.value;
  const id = 'studio-' + Date.now().toString(36) + '-' + (++cardSeq);
  cards.value.push({
    id,
    prompt,
    model_name: model?.display_name ?? '',
    ratio: studioRatio.value,
    count: studioCount.value,
    state: 'working',
    images: [],
    created_at: Date.now(),
  });
  // Read the card back through the array so mutations land on the reactive
  // proxy — the local object above is plain, and writing to it would draw nothing.
  const card = cards.value.find((entry) => entry.id === id)!;

  studioBusy.value = true;
  studioFlash.value = null;
  try {
    const result = await generateImages(generatePayload({
      model_id: studioModelID.value,
      prompt,
      ratio: studioRatio.value,
      count: studioCount.value,
      steps: studioSteps.value,
      ...(references.value.length ? { attachment_ids: references.value.map((entry) => entry.attachment.id) } : {}),
    }));
    card.images = result.images;
    card.state = 'done';
    studioDraft.value = '';
    // The server consumed the references on success; the failure path keeps
    // them so a corrected description can be sent without re-uploading.
    clearReferences();
    studioFlash.value = { text: t('studioNote'), error: false };
  } catch (error) {
    card.error = error instanceof ApiError ? error.message : String(error);
    card.state = 'failed';
    studioFlash.value = { text: t('toolboxFailed', { message: card.error }), error: true };
  } finally {
    studioBusy.value = false;
  }
}
