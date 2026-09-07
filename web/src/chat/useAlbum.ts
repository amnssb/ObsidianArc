// The account's album: every picture this account has generated, kept until
// deleted here or removed by the operator's retention policy.
//
// Opened from the avatar menu in the workspace header, so the studio stream
// stays the place where new work happens and the drawer is where old work is
// managed — the two views read the same rows from the same endpoints.

import { ref } from 'vue';
import { deleteImage, imageURL, listImages, type GeneratedImage } from '@/api/images';

export const albumOpen = ref(false);
export const albumImages = ref<GeneratedImage[]>([]);
export const albumLoading = ref(false);
export const albumSelected = ref<string[]>([]);

export function openAlbum(): void {
  albumOpen.value = true;
}

export function closeAlbum(): void {
  albumOpen.value = false;
}

export async function loadAlbum(): Promise<void> {
  albumLoading.value = true;
  try {
    const result = await listImages();
    albumImages.value = result.images;
    albumSelected.value = [];
  } catch {
    // An empty drawer with a working delete button beats a drawer that
    // refuses to open because one listing failed.
    albumImages.value = [];
    albumSelected.value = [];
  } finally {
    albumLoading.value = false;
  }
}

export function toggleAlbumImage(id: string, selected: boolean): void {
  albumSelected.value = selected
    ? [...albumSelected.value, id]
    : albumSelected.value.filter((entry) => entry !== id);
}

export function selectAllAlbum(): void {
  albumSelected.value = albumImages.value.map((image) => image.id);
}

export function clearAlbumSelection(): void {
  albumSelected.value = [];
}

export async function removeAlbumImage(id: string): Promise<void> {
  try {
    await deleteImage(id);
  } catch {
    // The row stays; the next open of the drawer tells the truth about what
    // the server actually holds.
    return;
  }
  albumImages.value = albumImages.value.filter((image) => image.id !== id);
  albumSelected.value = albumSelected.value.filter((entry) => entry !== id);
}

/**
 * Deletes the selection one picture at a time. A failed delete leaves its
 * picture in place rather than aborting the batch — the reader asked for all
 * of them to go, and one stubborn row should not keep the rest.
 */
export async function removeSelectedAlbum(): Promise<void> {
  for (const id of [...albumSelected.value]) {
    await removeAlbumImage(id);
  }
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
