// The image studio: a full page for generating pictures.
//
// A generation is not a conversation, so it does not live in the chat
// screen's furniture — it gets a page of its own, reached from the
// composer's + menu, with the composer's own endpoint (/api/images) and its
// own gallery. Nothing generated here ever becomes a chat turn, and nothing
// in the transcript is ever replayed here.
//
// The presets travel to the server as structured fields (ratio, count), not
// as text baked into the prompt: the backend knows which wire parameter the
// chosen model actually speaks, so the reader never has to.

import { ApiError, api } from '../api/client';
import { deleteImage, generateImages, imageURL, listImages, type GeneratedImage } from '../api/images';
import { renderShell } from '../app/shell';
import { t } from '../i18n';
import { ICONS, confirmable, el, icon } from '../ui/dom';
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

/** The ratios the page offers. Labels are the format itself, not prose. */
const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;

/** How many pictures one press may ask for. */
const COUNTS = [1, 2, 4] as const;

export function renderImagesPage(root: HTMLElement): void {
  const shell = renderShell(root);

  let models: AvailableModel[] = [];
  let selectedID = '';
  let ratio: string = RATIOS[0];
  let count: number = COUNTS[0];
  let generating = false;
  let history: GeneratedImage[] = [];

  const page = el('div', 'ai-images');

  const hero = el('div', 'ai-images-hero');
  hero.appendChild(el('h1', 'ai-images-title', t('imagesTitle')));
  hero.appendChild(el('p', 'ai-images-subtitle', t('imagesSubtitle')));
  page.appendChild(hero);

  // --- composer -----------------------------------------------------------------

  const composer = el('section', 'ai-images-composer');

  composer.appendChild(el('div', 'ai-images-label', t('toolboxModels')));
  const modelRow = el('div', 'ai-images-models');
  composer.appendChild(modelRow);

  function paintModels(): void {
    modelRow.textContent = '';
    if (!models.length) {
      modelRow.appendChild(el('p', 'ai-images-empty', t('toolboxNone')));
      return;
    }
    for (const model of models) {
      const pill = el('button', 'ai-images-model');
      pill.type = 'button';
      pill.classList.toggle('selected', model.id === selectedID);
      pill.appendChild(el('span', 'ai-images-model-name', model.display_name));
      if (model.description) pill.title = model.description;
      pill.addEventListener('click', () => {
        selectedID = model.id;
        paintModels();
        syncGenerate();
      });
      modelRow.appendChild(pill);
    }
  }

  function loadModels(): Promise<void> {
    return api.get<{ models: AvailableModel[] }>('/api/models')
      .then((result) => {
        // Either way to draw qualifies: a chat answer that carries pictures,
        // or a model the provider exposes on its native images endpoint.
        models = result.models.filter(
          (model) => (model.supports_image_output || model.supports_image_api) && model.usable !== false,
        );
        if (!models.some((model) => model.id === selectedID)) selectedID = models[0]?.id ?? '';
        paintModels();
        syncGenerate();
      })
      .catch(() => {
        // The page still renders; the generate press is what complains.
      });
  }

  composer.appendChild(el('div', 'ai-images-label', t('toolboxPrompt')));
  const promptArea = el('textarea', 'ai-images-prompt');
  promptArea.rows = 5;
  promptArea.maxLength = 2000;
  promptArea.placeholder = t('toolboxPromptPlaceholder');
  promptArea.addEventListener('input', syncGenerate);
  composer.appendChild(promptArea);

  const half = el('div', 'ai-images-halves');

  const ratioBox = el('div', 'ai-images-half');
  ratioBox.appendChild(el('div', 'ai-images-label', t('toolboxRatio')));
  const ratioRow = el('div', 'ai-images-pills');
  ratioRow.appendChild(pillGroup(RATIOS, ratio, (value) => { ratio = value; }));
  ratioBox.appendChild(ratioRow);
  half.appendChild(ratioBox);

  const countBox = el('div', 'ai-images-half');
  countBox.appendChild(el('div', 'ai-images-label', t('toolboxCount')));
  const countRow = el('div', 'ai-images-pills');
  countRow.appendChild(pillGroup(COUNTS, count, (value) => { count = Number(value); }));
  countBox.appendChild(countRow);
  half.appendChild(countBox);

  composer.appendChild(half);

  composer.appendChild(el('div', 'ai-images-label', t('toolboxExtra')));
  const extraInput = el('input', 'ai-images-extra');
  extraInput.type = 'text';
  extraInput.placeholder = t('toolboxExtraPlaceholder');
  extraInput.maxLength = 200;
  composer.appendChild(extraInput);

  const actionRow = el('div', 'ai-images-actions');
  const statusLine = el('p', 'ai-images-status');
  const generateBtn = el('button', 'ai-images-generate', t('toolboxGenerate'));
  generateBtn.type = 'button';
  generateBtn.addEventListener('click', () => {
    void generate();
  });
  actionRow.appendChild(generateBtn);
  actionRow.appendChild(statusLine);
  composer.appendChild(actionRow);

  page.appendChild(composer);

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

  function syncGenerate(): void {
    generateBtn.disabled = generating || !selectedID || !promptArea.value.trim();
    generateBtn.textContent = generating ? t('toolboxWorking') : t('toolboxGenerate');
  }

  async function generate(): Promise<void> {
    if (generating || !selectedID) return;
    const prompt = composeImagePrompt(promptArea.value, extraInput.value);
    if (!prompt) return;

    generating = true;
    statusLine.textContent = '';
    syncGenerate();
    try {
      const result = await generateImages({
        model_id: selectedID,
        prompt,
        ratio,
        count,
      });
      // Newest first, so what the reader just asked for is what they see.
      history = [...result.images, ...history];
      paintGallery();
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      statusLine.textContent = t('toolboxFailed', { message });
    } finally {
      generating = false;
      syncGenerate();
    }
  }

  // --- gallery --------------------------------------------------------------------

  const gallerySection = el('section', 'ai-images-gallery');
  gallerySection.appendChild(el('h2', 'ai-images-label', t('toolboxHistory')));
  const grid = el('div', 'ai-images-grid');
  gallerySection.appendChild(grid);
  const emptyNote = el('p', 'ai-images-empty', t('toolboxEmpty'));
  gallerySection.appendChild(emptyNote);
  page.appendChild(gallerySection);

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
      const tile = el('figure', 'ai-images-tile');
      const picture = document.createElement('img');
      picture.src = imageURL(image.id);
      picture.alt = image.prompt;
      picture.loading = 'lazy';
      picture.decoding = 'async';
      tile.appendChild(picture);

      const actions = el('div', 'ai-images-tile-actions');
      // Same-origin, so the attribute — not a blob URL — is the download.
      const download = document.createElement('a');
      download.href = imageURL(image.id);
      download.download = '';
      download.title = t('toolboxDownload');
      download.className = 'ai-images-tile-btn';
      download.appendChild(icon(ICONS.download, 15));
      actions.appendChild(download);

      const remove = el('button', 'ai-images-tile-btn');
      remove.type = 'button';
      remove.appendChild(icon(ICONS.trash, 15));
      confirmable(remove, { icon: ICONS.trash, title: t('toolboxDelete') }, () => {
        void deleteImage(image.id).then(() => {
          history = history.filter((entry) => entry.id !== image.id);
          paintGallery();
        });
      });
      actions.appendChild(remove);

      tile.appendChild(actions);

      const caption = el('figcaption', 'ai-images-tile-caption', image.prompt);
      caption.title = image.model_name + ' · ' + image.prompt;
      tile.appendChild(caption);

      grid.appendChild(tile);
    }
  }

  shell.body.appendChild(page);
  paintModels();
  syncGenerate();
  void loadModels();
  void loadHistory();
}
