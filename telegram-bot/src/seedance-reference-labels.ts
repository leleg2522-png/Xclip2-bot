/** Numbered aliases address image positions only; video/audio do not consume numbers. */
export const SEEDANCE_IMAGE_LABEL_HELP =
  'Gambar pertama = @1, gambar kedua = @2, dan seterusnya. ' +
  'Contoh: Karakter di @1 memakai baju dari @2. Nomor ini khusus gambar, bukan video/audio.';

export function seedanceImageLabels(imageCount: number): string {
  return imageCount
    ? `Gambar: ${Array.from({ length: imageCount }, (_, i) => `@${i + 1}`).join(', ')}.`
    : 'Belum ada gambar bernomor.';
}

export function validateSeedanceImageMentions(prompt: string, imageCount: number): string {
  for (const match of prompt.matchAll(/(?<![\p{L}\p{N}_])@(\d+)(?![\p{L}\p{N}_])/gu)) {
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n) || n < 1 || match[1] !== String(n) || n > imageCount) {
      throw Error(imageCount
        ? `Referensi ${match[0]} belum tersedia. ${seedanceImageLabels(imageCount)} Tambahkan foto atau perbaiki prompt.`
        : 'Belum ada gambar bernomor. Tambahkan foto untuk memakai @1, @2, dan seterusnya.');
    }
  }
  return prompt;
}
