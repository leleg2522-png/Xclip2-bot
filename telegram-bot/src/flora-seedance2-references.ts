// Conservative bot limit. Labels refer only to image array positions, not audio/video.
export const FLORA_SEEDANCE2_MAX_IMAGES = 9;

export function validateFloraSeedance2Mentions(prompt: string, imageCount: number): string {
  for (const match of prompt.matchAll(/(?<![\p{L}\p{N}_])@(\d+)(?![\p{L}\p{N}_])/gu)) {
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n) || n < 1 || match[1] !== String(n) || n > imageCount) {
      throw Error(imageCount
        ? `Referensi ${match[0]} belum tersedia. Gambar yang sudah diterima: ${Array.from({ length: imageCount }, (_, i) => `@${i + 1}`).join(', ')}. Tambahkan foto atau perbaiki prompt.`
        : 'Belum ada gambar bernomor. Tambahkan foto untuk memakai @1, @2, dan seterusnya.');
    }
  }
  return prompt;
}
