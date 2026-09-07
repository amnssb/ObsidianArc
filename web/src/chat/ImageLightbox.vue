<script setup lang="ts">
// One picture at full size, over everything else in the interface.
//
// It replaces the old "open in a new tab": a picture the reader wants to look
// at should never leave the app for it. OaOverlay brings the manners — Escape
// closes, a click on the backdrop closes, the fade keeps the exit calm — and
// the close button in the top right is the visible affordance. A click on the
// picture itself is deliberately inert: size alone is the point here, and an
// accidental click should not close what took a generation to produce.

import OaIconButton from '@/components/OaIconButton.vue';
import { t } from '@/composables/useI18n';
import { IconClose } from '@/icons';
import { closeLightbox, lightboxImage } from './useImageLightbox';
</script>

<template>
  <OaOverlay
    v-if="lightboxImage"
    v-slot="{ close }"
    overlay-class="oa-lightbox-overlay"
    @close="closeLightbox()"
  >
    <figure
      class="ai-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="lightboxImage.alt || t('viewImage')"
    >
      <OaIconButton class="ai-lightbox-close" :label="t('close')" @click="close">
        <IconClose :size="16" />
      </OaIconButton>
      <img
        class="ai-lightbox-img"
        :src="lightboxImage.src"
        :alt="lightboxImage.alt"
        decoding="async"
      >
      <figcaption v-if="lightboxImage.alt" class="ai-lightbox-caption">{{ lightboxImage.alt }}</figcaption>
    </figure>
  </OaOverlay>
</template>
