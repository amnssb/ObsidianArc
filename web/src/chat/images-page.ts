// The image studio: 生图 mode, drawn in place of the conversation.
//
// A generation is not a conversation, so it does not get a transcript — but
// it does not get a page of its own either. Entering the mode replaces the
// chat surface on the same shell, so the switch is one click each way and
// nothing about the frame around it moves. The composer is a single floating
// card: the prompt on top, upload and parameter settings on the lower left,
// and the round send button on the lower right. Everything the mode produces
// is stored server-side and loads again on the next visit; the album section
// in settings shows the same rows from further away.
//
// The presets travel to the server as structured fields (ratio, count), not
// as text baked into the prompt: the backend knows which wire parameter the
// chosen model actually speaks, so the reader never has to.

import { ApiError, api } from '../api/client';
import { uploadAttachment, type AttachmentRef } from '../api/chat';
import { deleteImage, generateImages, imageURL, listImages, type GeneratedImage, type GenerateInput } from '../api/images';
import { t } from '../i18n';
import { ICONS, confirmable, el, icon, iconButton } from '../ui/dom';
import { dropdown } from '../ui/menu';
import { ImageError, prepareImage, type PreparedImage } from './image';
import type { AvailableModel } from './model-picker';

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

/** The ratios the studio offers. Labels are the format itself, not prose. */
const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;

/** How many pictures one press may ask for. */
const COUNTS = [1, 2, 4] as const;

/**
 * The diffusion-steps presets. The first entry is the absent one: a model on
 * a provider endpoint that has no such field (or a quality knob of its own)
 * keeps its default, so "auto" is a value the UI shows and the payload omits.
 */
const STEPS = [
  { value: 0, key: 'studioStepsAuto' },
  { value: 20, key: null },
  { value: 30, key: null },
  { value: 40, key: null },
  { value: 50, key: null },
] as const;

/** Reference pictures one generation may carry; the server caps this too. */
const MAX_REFERENCES = 3;

const PROMPT_MAX_CHARS = 2000;

export interface ImageStudioOptions {
  /** Leaves 生图 mode and draws the conversation again. */
  exit(): void;
}

export function mountImageStudio(host: HTMLElement, options: ImageStudioOptions): void {
  let models: AvailableModel[] = [];
  let selectedID = '';
  let ratio: string = RATIOS[0];
  let count: number = COUNTS[0];
  let steps: number = STEPS[0].value;
  let generating = false;
  let history: GeneratedImage[] = [];
  let references: Array<{ ref: AttachmentRef; preview: string }> = [];

  // --- structure ---------------------------------------------------------------

  const studio = el('div', 'ai-studio');

  const top = el('div', 'ai-studio-top');
  top.appendChild(el('span', 'ai-studio-title', t('imagesTitle')));
  const exitBtn = el('button', 'ai-studio-exit', t('studioExit'));
  exitBtn.type = 'button';
  exitBtn.addEventListener('click', options.exit);
  top.appendChild(exitBtn);
  studio.appendChild(top);

  const card = el('section', 'ai-studio-card');

  const refStrip = el('div', 'ai-studio-refs');
  refStrip.hidden = true;
  card.appendChild(refStrip);

  const input = el('textarea', 'ai-studio-input');
  input.rows = 2;
  input.spellcheck = false;
  input.maxLength = PROMPT_MAX_CHARS;
  input.placeholder = t('toolboxPromptPlaceholder');
  card.appendChild(input);

  const fileInput = el('input', 'ai-chat-file');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.hidden = true;

  const uploadBtn = el('button', 'ai-studio-upload');
  uploadBtn.type = 'button';
  uploadBtn.appendChild(icon(ICONS.upload, 14));
  uploadBtn.appendChild(el('span', null, t('studioUpload')));

  const paramsTrigger = el('button', 'ai-studio-params');
  paramsTrigger.type = 'button';
  paramsTrigger.appendChild(icon(ICONS.sliders, 14));
  paramsTrigger.appendChild(el('span', null, t('studioParams')));

  const params = dropdown(paramsTrigger, (menu) => {
    menu.appendChild(buildParamsMenu());
  }, { groupClass: 'ai-studio-params-group', menuClass: 'oa-menu-up' });

  const left = el('div', 'ai-studio-left');
  left.appendChild(uploadBtn);
  // The dropdown wraps the trigger in a positioning group; the group is what
  // lands in the layout, not the bare button.
  left.appendChild(params.group);

  const sendBtn = el('button', 'ai-studio-send');
  sendBtn.type = 'button';
  sendBtn.appendChild(icon(ICONS.send, 18));

  const row = el('div', 'ai-studio-row');
  row.appendChild(left);
  row.appendChild(sendBtn);
  card.appendChild(row);
  card.appendChild(fileInput);
  studio.appendChild(card);

  // Under the card, because it is about what was just sent or is about to
  // be: the standing note says the records are kept, and an error takes the
  // line over for as long as it has something to say.
  const note = el('p', 'ai-studio-note', t('studioNote'));

  const gallery = el('section', 'ai-studio-gallery');
  const grid = el('div', 'ai-images-grid');
  const emptyNote = el('p', 'ai-images-empty', t('toolboxEmpty'));
  gallery.appendChild(el('h2', 'ai-images-label', t('toolboxHistory')));
  gallery.appendChild(grid);
  gallery.appendChild(emptyNote);
  studio.appendChild(note);
  studio.appendChild(gallery);

  host.appendChild(studio);

  // --- parameters popover --------------------------------------------------------

  function buildParamsMenu(): HTMLElement {
    const panel = el('div', 'ai-studio-params-menu');

    panel.appendChild(el('div', 'ai-images-label', t('toolboxModels')));
    const modelRow = el('div', 'ai-images-models');
    if (!models.length) {
      modelRow.appendChild(el('p', 'ai-images-empty', t('toolboxNone')));
    }
    for (const model of models) {
      const pill = el('button', 'ai-images-model');
      pill.type = 'button';
      pill.classList.toggle('selected', model.id === selectedID);
      pill.appendChild(el('span', null, model.display_name));
      if (model.description) pill.title = model.description;
      pill.addEventListener('click', () => {
        selectedID = model.id;
        for (const child of modelRow.children) child.classList.remove('selected');
        pill.classList.add('selected');
        syncControls();
      });
      modelRow.appendChild(pill);
    }
    panel.appendChild(modelRow);

    const halves = el('div', 'ai-studio-params-halves');

    const ratioBox = el('div', 'ai-studio-params-half');
    ratioBox.appendChild(el('div', 'ai-images-label', t('toolboxRatio')));
    ratioBox.appendChild(pillGroup(RATIOS, ratio, (value) => { ratio = value; }));
    halves.appendChild(ratioBox);

    const countBox = el('div', 'ai-studio-params-half');
    countBox.appendChild(el('div', 'ai-images-label', t('toolboxCount')));
    countBox.appendChild(pillGroup(COUNTS, count, (value) => { count = Number(value); }));
    halves.appendChild(countBox);

    panel.appendChild(halves);

    panel.appendChild(el('div', 'ai-images-label', t('toolboxSteps')));
    const stepRow = el('div', 'ai-images-pill-group');
    for (const entry of STEPS) {
      const pill = el('button', 'ai-images-pill');
      pill.type = 'button';
      pill.textContent = entry.key ? t(entry.key) : String(entry.value);
      pill.classList.toggle('selected', entry.value === steps);
      pill.addEventListener('click', () => {
        steps = entry.value;
        for (const child of stepRow.children) child.classList.remove('selected');
        pill.classList.add('selected');
      });
      stepRow.appendChild(pill);
    }
    panel.appendChild(stepRow);

    panel.appendChild(el('div', 'ai-images-label', t('toolboxExtra')));
    const extra = el('input', 'ai-images-extra');
    extra.type = 'text';
    extra.placeholder = t('toolboxExtraPlaceholder');
    extra.maxLength = 200;
    panel.appendChild(extra);

    return panel;
  }

  function pillGroup(values: readonly (string | number)[], current: string | number, pick: (value: string) => void): HTMLElement {
    const group = el('div', 'ai-images-pill-group');
    for (const value of values) {
      const pill = el('button', 'ai-images-pill');
      pill.type = 'button';
      pill.textContent = String(value);
      pill.classList.toggle('selected', String(value) === String(current));
      pill.addEventListener('click', () => {
        pick(String(value));
        for (const child of group.children) child.classList.remove('selected');
        pill.classList.add('selected');
      });
      group.appendChild(pill);
    }
    return group;
  }

  // --- reference pictures ----------------------------------------------------------

  // A model that draws only on its provider's images endpoint cannot look at
  // a picture: the upload button says so instead of failing after the fact.
  const referencesSupported = (): boolean => {
    const model = models.find((entry) => entry.id === selectedID);
    return !!model && (model.supports_images || !model.supports_image_api);
  };

  function paintReferences(): void {
    refStrip.textContent = '';
    refStrip.hidden = references.length === 0;
    for (const entry of references) {
      const chip = el('div', 'ai-studio-ref');
      const thumb = el('img', 'ai-studio-ref-img');
      thumb.src = entry.preview;
      thumb.alt = '';
      thumb.draggable = false;
      chip.appendChild(thumb);
      chip.appendChild(iconButton('ai-studio-ref-remove', ICONS.close, t('removeImage'), () => {
        URL.revokeObjectURL(entry.preview);
        references = references.filter((other) => other !== entry);
        paintReferences();
      }, 11));
      refStrip.appendChild(chip);
    }
  }

  async function addFiles(list: FileList | File[] | null): Promise<void> {
    if (generating || !referencesSupported()) return;
    const files = Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;

    const room = MAX_REFERENCES - references.length;
    if (room <= 0) {
      setNote(t('tooManyImages', { count: MAX_REFERENCES }), true);
      return;
    }

    for (const file of files.slice(0, room)) {
      let prepared: PreparedImage;
      try {
        prepared = await prepareImage(file);
      } catch (error) {
        setNote(error instanceof ImageError ? error.message : t('imageFailed'), true);
        continue;
      }
      try {
        const { attachment } = await uploadAttachment({
          mime: prepared.mime,
          data: prepared.data,
          width: prepared.width,
          height: prepared.height,
        });
        references.push({ ref: attachment, preview: prepared.previewURL });
        paintReferences();
      } catch (error) {
        URL.revokeObjectURL(prepared.previewURL);
        setNote(error instanceof ApiError ? error.message : t('imageFailed'), true);
      }
    }
  }

  function clearReferences(): void {
    for (const entry of references) URL.revokeObjectURL(entry.preview);
    references = [];
    paintReferences();
  }

  uploadBtn.addEventListener('click', () => {
    if (!referencesSupported()) {
      setNote(t('studioUploadUnsupported'), true);
      return;
    }
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    void addFiles(files);
  });
  input.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });

  // --- generating -----------------------------------------------------------------

  function resizeInput(): void {
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight) + 'px';
  }

  function setNote(text: string, error: boolean): void {
    note.textContent = text;
    note.classList.toggle('error', error);
  }

  function syncControls(): void {
    sendBtn.disabled = generating || !selectedID || !input.value.trim();
    sendBtn.classList.toggle('working', generating);
    sendBtn.title = t(generating ? 'toolboxWorking' : 'studioSend');
    sendBtn.setAttribute('aria-label', sendBtn.title);
    uploadBtn.disabled = generating;
  }

  sendBtn.addEventListener('click', () => void generate());
  input.addEventListener('input', () => {
    resizeInput();
    syncControls();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void generate();
  });

  async function generate(): Promise<void> {
    if (generating || !selectedID) return;
    const prompt = composeImagePrompt(input.value);
    if (!prompt) return;

    generating = true;
    syncControls();
    setNote(t('toolboxWorking'), false);
    try {
      const result = await generateImages(generatePayload({
        model_id: selectedID,
        prompt,
        ratio,
        count,
        steps,
        ...(references.length ? { attachment_ids: references.map((entry) => entry.ref.id) } : {}),
      }));
      // Newest first, so what the reader just asked for is what they see.
      history = [...result.images, ...history];
      input.value = '';
      resizeInput();
      // The server consumed the references on success; the failure path
      // keeps them so a corrected description can be sent without
      // re-uploading.
      clearReferences();
      paintGallery();
      setNote(t('studioNote'), false);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      setNote(t('toolboxFailed', { message }), true);
    } finally {
      generating = false;
      syncControls();
    }
  }

  // --- gallery ---------------------------------------------------------------------

  async function loadHistory(): Promise<void> {
    try {
      const result = await listImages();
      history = result.images;
      paintGallery();
    } catch {
      // The gallery is the page's second half, not its purpose: a failed
      // listing still leaves a working generate button.
    }
  }

  function paintGallery(): void {
    grid.textContent = '';
    emptyNote.hidden = history.length > 0;
    for (const image of history) {
      grid.appendChild(imageTile(image, () => {
        history = history.filter((entry) => entry.id !== image.id);
        paintGallery();
      }));
    }
  }

  async function loadModels(): Promise<void> {
    try {
      const result = await api.get<{ models: AvailableModel[] }>('/api/models');
      // Either way to draw qualifies: a chat answer that carries pictures,
      // or a model the provider exposes on its native images endpoint.
      models = result.models.filter(
        (model) => (model.supports_image_output || model.supports_image_api) && model.usable !== false,
      );
      if (!models.some((model) => model.id === selectedID)) selectedID = models[0]?.id ?? '';
    } catch {
      // The studio still renders; the generate press is what complains.
    }
    syncControls();
  }

  void loadModels();
  syncControls();
  void loadHistory();
  resizeInput();
  input.focus();
}

// --- gallery tiles ------------------------------------------------------------------

/**
 * One picture in a gallery grid, with its download and delete controls.
 *
 * Shared by the studio and the album in settings: they are two views of the
 * same rows, and two tile builders would drift — one would grow the date,
 * the other a caption, and neither would look like its sibling.
 */
export function imageTile(image: GeneratedImage, onDeleted?: () => void, options: ImageTileOptions = {}): HTMLElement {
  const tile = el('figure', 'ai-images-tile');
  const picture = document.createElement('img');
  picture.src = imageURL(image.id);
  picture.alt = image.prompt;
  picture.loading = 'lazy';
  picture.decoding = 'async';
  tile.appendChild(picture);

  if (options.selectable) {
    // A real checkbox rather than a painted one: the batch download is a
    // management action, and a control that reads as a checkbox to assistive
    // technology keeps it honest.
    const check = el('input', 'ai-images-tile-check') as HTMLInputElement;
    check.type = 'checkbox';
    check.checked = options.selected === true;
    check.title = t('albumPick');
    check.setAttribute('aria-label', t('albumPick'));
    check.addEventListener('change', () => options.onToggle?.(check.checked));
    tile.appendChild(check);
  }

  const actions = el('div', 'ai-images-tile-actions');
  // Same-origin, so the attribute — not a blob URL — is the download, and it
  // carries a real filename because the server serves these inline.
  const download = document.createElement('a');
  download.href = imageURL(image.id);
  download.download = imageFileName(image);
  download.title = t('toolboxDownload');
  download.className = 'ai-images-tile-btn';
  download.appendChild(icon(ICONS.download, 15));
  actions.appendChild(download);

  if (onDeleted) {
    const remove = el('button', 'ai-images-tile-btn');
    remove.type = 'button';
    remove.appendChild(icon(ICONS.trash, 15));
    confirmable(remove, { icon: ICONS.trash, title: t('toolboxDelete') }, () => {
      void deleteImage(image.id).then(() => onDeleted());
    });
    actions.appendChild(remove);
  }
  tile.appendChild(actions);

  const caption = el('figcaption', 'ai-images-tile-caption', image.prompt);
  caption.title = image.model_name + ' · ' + image.prompt;
  tile.appendChild(caption);
  return tile;
}

/** Options for the album's selection affordance on a tile. */
export interface ImageTileOptions {
  /** Draws the checkbox overlay. */
  selectable?: boolean;
  selected?: boolean;
  onToggle?(selected: boolean): void;
}

/**
 * A filename for one generated picture, derived from what it actually is:
 * the server serves these inline, so the extension has to be honest about
 * the bytes rather than guessed from the model's name.
 */
export function imageFileName(image: GeneratedImage): string {
  const kind = image.mime.split('/')[1] ?? 'png';
  const extension = kind === 'jpeg' ? 'jpg' : kind === 'svg+xml' ? 'svg' : kind;
  return 'image-' + image.id + '.' + extension;
}

/**
 * Saves a batch of pictures one after another. Browsers swallow programmatic
 * downloads fired in the same tick, so each gets its own beat; this is a
 * folder of loose files rather than an archive because an archive would
 * mean a zip writer, and this project ships none.
 */
export function downloadImages(images: GeneratedImage[]): void {
  images.forEach((image, index) => {
    window.setTimeout(() => {
      const anchor = document.createElement('a');
      anchor.href = imageURL(image.id);
      anchor.download = imageFileName(image);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }, index * 250);
  });
}


