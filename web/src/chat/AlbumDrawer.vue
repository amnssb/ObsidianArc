<script setup lang="ts">
// The account's album, over the page as a drawer.
//
// A drawer rather than a column, because it is reached from the account menu
// in the header — a place that exists no matter which screen is under it —
// and a column beside the chat would mean a route for a thing that is really
// a look at the account's own pictures. It slides in from the right, the way
// the workspace's settings drawer does.
//
// Batch actions live in one toolbar: select, download, delete. The delete is
// a two-click confirm of its own, because emptying half an album by accident
// is not undoable by anything in this interface.

import { computed, watch } from 'vue';
import { imageURL } from '@/api/images';
import OaConfirmButton from '@/components/OaConfirmButton.vue';
import OaIconButton from '@/components/OaIconButton.vue';
import OaOverlay from '@/components/OaOverlay.vue';
import { t } from '@/composables/useI18n';
import { IconCheck, IconClose, IconDownload, IconImage, IconTrash } from '@/icons';
import {
  albumImages, albumLoading, albumOpen, albumSelected,
  clearAlbumSelection, closeAlbum, downloadImages, imageFileName,
  loadAlbum, removeAlbumImage, removeSelectedAlbum, selectAllAlbum,
  toggleAlbumImage,
} from './useAlbum';

watch(albumOpen, (open) => {
  if (open) void loadAlbum();
});

const allSelected = computed(() => {
  return albumImages.value.length > 0 && albumSelected.value.length === albumImages.value.length;
});

function downloadSelected(): void {
  const chosen = albumImages.value.filter((image) => albumSelected.value.includes(image.id));
  downloadImages(chosen);
}
</script>

<template>
  <OaOverlay v-if="albumOpen" v-slot="{ close }" overlay-class="oa-album-overlay" @close="closeAlbum()">
    <aside class="ai-album-drawer" role="dialog" aria-modal="true" :aria-label="t('navAlbum')">
      <header class="ai-album-head">
        <IconImage :size="15" />
        <h2 class="ai-album-title">{{ t('navAlbum') }}</h2>
        <span
          v-if="albumSelected.length"
          class="ai-album-count"
        >{{ t('albumSelectedCount', { count: albumSelected.length }) }}</span>
        <OaIconButton :label="t('close')" @click="close">
          <IconClose :size="14" />
        </OaIconButton>
      </header>

      <div class="ai-album-toolbar">
        <button
          type="button"
          class="ai-images-pill"
          :class="{ selected: allSelected }"
          @click="allSelected ? clearAlbumSelection() : selectAllAlbum()"
        >{{ t('albumSelectAll') }}</button>
        <button
          type="button"
          class="ai-images-pill"
          :disabled="!albumSelected.length"
          @click="clearAlbumSelection"
        >{{ t('albumClear') }}</button>
        <span class="ai-album-toolbar-spacer" />
        <button
          type="button"
          class="ai-images-pill"
          :disabled="!albumSelected.length"
          @click="downloadSelected"
        >{{ t('albumDownloadSelected') }}</button>
        <OaConfirmButton
          class="ai-images-pill ai-album-delete"
          :armed-label="t('confirmDelete')"
          :armed-title="t('confirmDelete')"
          :disabled="!albumSelected.length"
          @confirm="removeSelectedAlbum"
        >
          <IconTrash :size="12" />
          <span>{{ t('albumDeleteSelected') }}</span>
          <template #armed><IconCheck :size="12" /></template>
        </OaConfirmButton>
      </div>

      <div class="ai-album-body">
        <p v-if="albumLoading" class="ai-images-empty">{{ t('loading') }}</p>
        <div v-else-if="albumImages.length" class="ai-images-grid">
          <figure v-for="image in albumImages" :key="image.id" class="ai-images-tile">
            <img :src="imageURL(image.id)" :alt="image.prompt" loading="lazy" decoding="async">
            <input
              type="checkbox"
              class="ai-images-tile-check"
              :checked="albumSelected.includes(image.id)"
              :aria-label="t('albumPick')"
              @change="toggleAlbumImage(image.id, ($event.target as HTMLInputElement).checked)"
            >
            <div class="ai-images-tile-actions">
              <a
                class="ai-images-tile-btn"
                :href="imageURL(image.id)"
                :download="imageFileName(image)"
                :title="t('toolboxDownload')"
              ><IconDownload :size="13" /></a>
              <OaConfirmButton
                class="ai-images-tile-btn"
                :resting-title="t('toolboxDelete')"
                :armed-title="t('toolboxDelete')"
                @confirm="removeAlbumImage(image.id)"
              >
                <IconTrash :size="13" />
                <template #armed><IconCheck :size="13" /></template>
              </OaConfirmButton>
            </div>
            <figcaption class="ai-images-tile-caption" :title="image.prompt">{{ image.prompt }}</figcaption>
          </figure>
        </div>
        <p v-else class="ai-images-empty">{{ t('albumEmpty') }}</p>
      </div>
    </aside>
  </OaOverlay>
</template>
