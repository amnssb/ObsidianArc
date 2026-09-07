<script setup lang="ts">
// The 生图 surface, drawn in place of the conversation.
//
// A generation is not a conversation, so it does not get a transcript — but it
// does not get a page of its own either: this component is swapped into the
// chat's main column while the rail beside it stays. The stream behaves like
// the transcript does — every press appends a card at the bottom and the view
// follows — and the composer is one floating card docked under it, the way
// the chat's composer floats under the answers.
//
// A light tag on the composer names the mode and is also the way out: one
// click returns to the conversation, no banner above the stream required.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { imageURL } from '@/api/images';
import OaIconButton from '@/components/OaIconButton.vue';
import OaMenu from '@/components/OaMenu.vue';
import { t } from '@/composables/useI18n';
import { relativeTime } from '@/lib/format';
import { IconClose, IconImage, IconSliders, IconSpark } from '@/icons';
import {
  PROMPT_MAX_CHARS, RATIOS, STEPS, COUNTS,
  addReferenceFiles, cards, ensureStudioModel, generateInStudio, imageModels,
  references, referencesSupported, removeReference, studioBusy, studioCount,
  studioDraft, studioFlash, studioModelID, studioNotes,
  studioRatio, studioSteps,
} from './useImageStudio';
import { loadModels, models } from './useModels';

const router = useRouter();

const input = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const stream = ref<HTMLElement | null>(null);

const uploadDisabled = computed(() => studioBusy.value);

const sendDisabled = computed(() =>
  studioBusy.value || !studioModelID.value || !studioDraft.value.trim(),
);

function pickModel(id: string): void {
  if (imageModels.value.some((model) => model.id === id)) studioModelID.value = id;
}

onMounted(async () => {
  // ChatLayout loads the model list for the conversation; reuse it when it is
  // already here, and only fetch when the studio is the first screen drawn.
  if (!models.value.length) {
    await loadModels().catch(() => {
      // The studio still renders; the generate press is what complains.
    });
  }
  ensureStudioModel();
  input.value?.focus({ preventScroll: true });
});

// A model list that arrives after the mount (or loses the chosen model to an
// administrator's edit) still leaves the composer pointing at something.
watch(imageModels, ensureStudioModel);

function resize(): void {
  const node = input.value;
  if (!node) return;
  node.style.height = 'auto';
  node.style.height = `${Math.min(220, node.scrollHeight)}px`;
}

watch(studioDraft, () => void nextTick(resize));
onBeforeUnmount(resize);

/**
 * The stream copies the transcript's manners: follow the newest card, but
 * only while the reader is already at the bottom — yanking the view back
 * while somebody is looking at an earlier picture is worse than letting the
 * new one land off screen.
 */
watch(() => cards.value.length + ' ' + (cards.value[cards.value.length - 1]?.state ?? ''), () => {
  void nextTick(() => {
    const node = stream.value;
    if (!node) return;
    const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (!atEnd && studioBusy.value) return;
    node.scrollTop = node.scrollHeight;
  });
});

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void generateInStudio();
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  void addReferenceFiles(files);
}

function takeFiles(): void {
  const node = fileInput.value;
  const files = Array.from(node?.files ?? []);
  if (node) node.value = '';
  void addReferenceFiles(files);
}

function pickReferenceFiles(): void {
  if (!referencesSupported()) {
    studioFlash.value = { text: t('studioUploadUnsupported'), error: true };
    return;
  }
  fileInput.value?.click();
}

function exit(): void {
  void router.push('/');
}
</script>

<template>
  <div class="ai-chat-main ai-studio">
    <div ref="stream" class="ai-studio-stream">
      <div v-if="!cards.length" class="ai-chat-empty ai-studio-empty">
        <h3 class="ai-chat-empty-title">{{ t('imagesTitle') }}</h3>
        <p class="ai-chat-empty-body">{{ t('toolboxEmpty') }}</p>
        <p class="ai-chat-empty-body">{{ t('studioNote') }}</p>
      </div>

      <article
        v-for="card in cards"
        :key="card.id"
        class="ai-studio-msg"
        :class="{ working: card.state === 'working' }"
      >
        <p class="ai-studio-msg-prompt">{{ card.prompt }}</p>
        <div v-if="card.state === 'working'" class="ai-studio-msg-status">
          <span class="ai-studio-spinner" aria-hidden="true" />
          <span>{{ t('toolboxWorking') }}</span>
        </div>
        <p v-else-if="card.state === 'failed'" class="ai-studio-msg-error">{{ card.error }}</p>
        <div
          v-else
          class="ai-studio-msg-grid"
          :data-count="card.images.length"
        >
          <a
            v-for="image in card.images"
            :key="image.id"
            class="ai-studio-msg-img"
            :href="imageURL(image.id)"
            target="_blank"
            rel="noopener"
          >
            <img :src="imageURL(image.id)" :alt="card.prompt" loading="lazy" decoding="async">
          </a>
        </div>
        <p class="ai-studio-msg-meta">
          {{ card.model_name }} · {{ card.ratio }} · {{ relativeTime(card.created_at) }}
        </p>
      </article>
    </div>

    <p
      class="ai-studio-flash"
      :class="{ visible: !!studioFlash, error: studioFlash?.error }"
      role="status"
      aria-live="polite"
    >{{ studioFlash?.text }}</p>

    <form class="ai-studio-card" @submit.prevent="generateInStudio">
      <div class="ai-studio-tagrow">
        <span class="ai-studio-tag">
          <IconImage :size="12" />
          <span>{{ t('imagesTitle') }}</span>
          <button type="button" class="ai-studio-tag-exit" :title="t('studioExit')" :aria-label="t('studioExit')" @click="exit">
            <IconClose :size="11" />
          </button>
        </span>
      </div>

      <div v-if="references.length" class="ai-studio-refs">
        <div v-for="(entry, index) in references" :key="entry.attachment.id" class="ai-studio-ref">
          <img class="ai-studio-ref-img" :src="entry.preview" alt="" :draggable="false">
          <OaIconButton class="ai-studio-ref-remove" :label="t('removeImage')" @click="removeReference(index)">
            <IconClose :size="11" />
          </OaIconButton>
        </div>
      </div>

      <textarea
        ref="input"
        v-model="studioDraft"
        class="ai-studio-input"
        rows="2"
        spellcheck="false"
        :maxlength="PROMPT_MAX_CHARS"
        :placeholder="t('toolboxPromptPlaceholder')"
        :disabled="studioBusy"
        @input="resize"
        @keydown="onKeyDown"
        @paste="onPaste"
      />

      <div class="ai-studio-row">
        <div class="ai-studio-left">
          <button
            type="button"
            class="ai-studio-upload"
            :disabled="uploadDisabled"
            @click="pickReferenceFiles"
          >{{ t('studioUpload') }}</button>

          <OaMenu menu-class="oa-menu-up">
            <template #trigger="{ open, toggle }">
              <button
                type="button"
                class="ai-studio-params"
                :aria-expanded="open ? 'true' : 'false'"
                @click="toggle"
              >
                <IconSliders :size="14" />
                <span>{{ t('studioParams') }}</span>
              </button>
            </template>

            <template #default>
              <div class="ai-studio-params-menu">
                <p class="ai-images-label">{{ t('toolboxModels') }}</p>
                <div class="ai-images-models">
                  <p v-if="!imageModels.length" class="ai-images-empty">{{ t('toolboxNone') }}</p>
                  <button
                    v-for="model in imageModels"
                    :key="model.id"
                    type="button"
                    class="ai-images-model"
                    :class="{ selected: model.id === studioModelID }"
                    :title="model.description"
                    @click="pickModel(model.id)"
                  >{{ model.display_name }}</button>
                </div>

                <div class="ai-studio-params-halves">
                  <div class="ai-studio-params-half">
                    <p class="ai-images-label">{{ t('toolboxRatio') }}</p>
                    <div class="ai-images-pill-group">
                      <button
                        v-for="ratio in RATIOS"
                        :key="ratio"
                        type="button"
                        class="ai-images-pill"
                        :class="{ selected: ratio === studioRatio }"
                        @click="studioRatio = ratio"
                      >{{ ratio }}</button>
                    </div>
                  </div>
                  <div class="ai-studio-params-half">
                    <p class="ai-images-label">{{ t('toolboxCount') }}</p>
                    <div class="ai-images-pill-group">
                      <button
                        v-for="count in COUNTS"
                        :key="count"
                        type="button"
                        class="ai-images-pill"
                        :class="{ selected: count === studioCount }"
                        @click="studioCount = count"
                      >{{ count }}</button>
                    </div>
                  </div>
                </div>

                <p class="ai-images-label">{{ t('toolboxSteps') }}</p>
                <div class="ai-images-pill-group">
                  <button
                    v-for="entry in STEPS"
                    :key="entry.value"
                    type="button"
                    class="ai-images-pill"
                    :class="{ selected: entry.value === studioSteps }"
                    @click="studioSteps = entry.value"
                  >{{ entry.key ? t(entry.key) : entry.value }}</button>
                </div>

                <p class="ai-images-label">{{ t('toolboxExtra') }}</p>
                <input
                  v-model="studioNotes"
                  class="ai-images-extra"
                  type="text"
                  :placeholder="t('toolboxExtraPlaceholder')"
                  maxlength="200"
                >
              </div>
            </template>
          </OaMenu>
        </div>

        <button
          type="submit"
          class="ai-studio-send"
          :class="{ working: studioBusy }"
          :disabled="sendDisabled"
          :title="t('studioSend')"
          :aria-label="t('studioSend')"
        >
          <IconSpark :size="16" />
        </button>
      </div>

      <input
        ref="fileInput"
        class="ai-chat-file"
        type="file"
        accept="image/*"
        multiple
        hidden
        @change="takeFiles"
      >
    </form>
  </div>
</template>
