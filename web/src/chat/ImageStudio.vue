<script setup lang="ts">
// The 生图 surface, drawn in place of the conversation.
//
// A generation joins the conversation it was asked from, so the stream is the
// conversation's history projected: the prompt you sent, the pictures that
// came back, and any plain answers the same conversation carries — which is
// what makes a switch in the rail replay everything. The component itself is
// swapped into the chat's main column while the rail beside it stays, and the
// composer is one floating card docked under the stream, the way the chat's
// composer floats under the answers.
//
// A light tag on the composer names the mode and is also the way out: one
// click returns to the conversation, no banner above the stream required.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { attachmentURL } from '@/api/chat';
import OaIconButton from '@/components/OaIconButton.vue';
import OaMenu from '@/components/OaMenu.vue';
import { t } from '@/composables/useI18n';
import { relativeTime } from '@/lib/format';
import { IconClose, IconImage, IconSliders, IconSpark } from '@/icons';
import {
  PROMPT_MAX_CHARS, RATIOS, STEPS, COUNTS,
  addReferenceFiles, ensureStudioModel, generateInStudio, imageModels,
  references, referencesSupported, removeReference, studioBusy, studioCount,
  studioDraft, studioFlash, studioItems, studioModelID, studioNotes,
  studioRatio, studioSteps,
} from './useImageStudio';
import { openLightbox } from './useImageLightbox';
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
 * new one land off screen. The length moves when a turn is recorded or the
 * working card lands; the busy flag catches the reload that replaces it.
 */
watch([() => studioItems.value.length, studioBusy], () => {
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

/**
 * A picture opens at full size over the app, never in a new tab: leaving the
 * interface to look at what the interface produced is the wrong direction.
 */
function enlarge(src: string, alt: string): void {
  openLightbox(src, alt);
}
</script>

<template>
  <div class="ai-chat-main ai-studio">
    <div ref="stream" class="ai-studio-stream">
      <div v-if="!studioItems.length" class="ai-chat-empty ai-studio-empty">
        <h3 class="ai-chat-empty-title">{{ t('imagesTitle') }}</h3>
        <p class="ai-chat-empty-body">{{ t('toolboxEmpty') }}</p>
        <p class="ai-chat-empty-body">{{ t('studioNote') }}</p>
      </div>

      <template v-for="item in studioItems" :key="item.id">
        <!-- A turn that carried only words: readable where it happened. -->
        <article v-if="item.kind === 'text'" class="ai-studio-msg ai-studio-msg-text">
          <p :class="item.role === 'user' ? 'ai-studio-msg-prompt' : 'ai-studio-msg-answer'">{{ item.content }}</p>
        </article>

        <article v-else class="ai-studio-msg" :class="{ working: item.working }">
          <p class="ai-studio-msg-prompt">{{ item.prompt }}</p>
          <div v-if="item.working" class="ai-studio-msg-status">
            <span class="ai-studio-spinner" aria-hidden="true" />
            <span>{{ t('toolboxWorking') }}</span>
          </div>
          <div
            v-else
            class="ai-studio-msg-grid"
            :data-count="item.images.length"
          >
            <button
              v-for="image in item.images"
              :key="image.id"
              type="button"
              class="ai-studio-msg-img"
              :title="t('viewImage')"
              :aria-label="t('viewImage')"
              @click="enlarge(attachmentURL(image.id), item.prompt)"
            >
              <img :src="attachmentURL(image.id)" :alt="item.prompt" loading="lazy" decoding="async">
            </button>
          </div>
          <p v-if="!item.working" class="ai-studio-msg-meta">
            {{ item.model_name }} · {{ relativeTime(item.created_at) }}
          </p>
        </article>
      </template>
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
