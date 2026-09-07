// The image lightbox's state: which picture is open, at full size, over
// everything else.
//
// A module-level ref rather than local component state, because three
// surfaces open the same lightbox — the studio's stream, the album drawer and
// the transcript's own attachment strip — and none of them should know about
// the others. The component reads this and the surfaces call openLightbox().

import { ref } from 'vue';

export const lightboxImage = ref<{ src: string; alt: string } | null>(null);

/** Opens a picture at full size. The alt text is what the lightbox reads back. */
export function openLightbox(src: string, alt = ''): void {
  lightboxImage.value = { src, alt };
}

export function closeLightbox(): void {
  lightboxImage.value = null;
}
