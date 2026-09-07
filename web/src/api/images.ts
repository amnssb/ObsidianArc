// The image toolbox's API: generate, list, delete.
//
// The pictures themselves are never base64 through JSON — the panel points
// an <img> (or a download link) at GET /api/images/{id}, which serves the
// bytes with the ownership check and the cache headers.
import { api } from './client';

export interface GeneratedImage {
  id: string;
  model_id: string;
  model_name: string;
  prompt: string;
  size: string;
  mime: string;
  bytes: number;
  created_at: number;
}

export interface GenerateInput {
  model_id: string;
  prompt: string;
  ratio: string;
  count: number;
  /**
   * Diffusion sampling steps, when the reader set one. Absent — never zero —
   * so endpoints without the field, and the strict official images API among
   * them, never see an argument they would refuse.
   */
  steps?: number;
  /**
   * Uploads (via the attachment endpoint) sent along as reference material.
   * The server consumes them on success; on failure they stay in the
   * composer, so a corrected description can be sent without re-uploading.
   */
  attachment_ids?: string[];
}

export function generateImages(input: GenerateInput): Promise<{ images: GeneratedImage[] }> {
  return api.post('/api/images', input);
}

export function listImages(): Promise<{ images: GeneratedImage[] }> {
  return api.get('/api/images');
}

export function deleteImage(id: string): Promise<void> {
  return api.delete('/api/images/' + id);
}

export function imageURL(id: string): string {
  return '/api/images/' + id;
}
