import { randomUUID } from 'node:crypto';

export const GENJUTSU_PRICES = Object.freeze({ 15: 4500, 30: 8000 });

export const GENJUTSU_NEGATIVE_PROMPT =
  'original face, blended faces, changing identity, distorted face, changed background, extra people, subtitles';

// Seedance documents no separate negative-prompt field. These are inline text
// exclusions, not an unsupported API parameter or guaranteed conditioning.
export const GENJUTSU_PROMPT =
  'Replace the character in the reference video with the character in the reference image.' +
  `\n\nAvoid: ${GENJUTSU_NEGATIVE_PROMPT}.`;

export interface GenjutsuFile {
  file_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

export interface GenjutsuDraft {
  id: string;
  step: 'package' | 'video' | 'checking_video' | 'image' | 'checking_image' | 'confirm' | 'submitting';
  maxReferenceSeconds?: 15 | 30;
  video?: { fileId: string; mime: string; duration: number };
  imageFileId?: string;
  imageFileIds?: string[];
  pendingImageFileIds?: string[];
}

interface Dependencies {
  get(userId: number): GenjutsuDraft | undefined;
  set(userId: number, draft: GenjutsuDraft): void;
  price(seconds: 15 | 30): string;
  inspectVideo(ctx: any, file: GenjutsuFile): Promise<number>;
  inspectImage(ctx: any, file: GenjutsuFile): Promise<void>;
  submit(ctx: any, draft: GenjutsuDraft, prompt: string): Promise<unknown>;
}

const maxBytes = 19 * 1024 * 1024;
const imageIds = (draft: GenjutsuDraft) => draft.imageFileIds ?? (draft.imageFileId ? [draft.imageFileId] : []);
function imageKeyboard(draft: GenjutsuDraft) {
  return { reply_markup: { inline_keyboard: [
    ...(imageIds(draft).length && !draft.pendingImageFileIds?.length
      ? [[{ text: `Selesai tambah gambar · ${imageIds(draft).length}/10`, callback_data: `genjutsu_images_done_${draft.id}` }]]
      : []),
    [{ text: 'Batal · Menu Utama', callback_data: 'back_main' }],
  ] } };
}
function keyboard(draft?: GenjutsuDraft, price?: string) {
  return { reply_markup: { inline_keyboard: [
    ...(draft ? [[{ text: `Generate · ${price}`, callback_data: `genjutsu_generate_${draft.id}` }]] : []),
    [{ text: 'Batal · Menu Utama', callback_data: 'back_main' }],
  ] } };
}

function packageKeyboard(draft: GenjutsuDraft, price: Dependencies['price']) {
  return { reply_markup: { inline_keyboard: [
    [{ text: `Paket 15 detik · ${price(15)} · Referensi 3–15 detik`, callback_data: `genjutsu_duration_15_${draft.id}` }],
    [{ text: `Paket 30 detik · ${price(30)} · Referensi 3–30 detik`, callback_data: `genjutsu_duration_30_${draft.id}` }],
    [{ text: 'Batal · Menu Utama', callback_data: 'back_main' }],
  ] } };
}

/** Separate wizard; never takes a prompt or media from a regular Flash draft. */
export function createGenjutsuFlow(deps: Dependencies) {
  async function message(ctx: any) {
    const draft = deps.get(ctx.from.id);
    if (!draft) return;
    if (draft.step === 'package') return ctx.reply('Pilih paket durasi video referensi Genjutsu.', packageKeyboard(draft, deps.price));
    if (draft.step === 'image') return ctx.reply(
      `Genjutsu: kirim 1–10 gambar referensi, maksimal 19MB per gambar dan total referensi 100MB. ` +
      `${imageIds(draft).length - (draft.pendingImageFileIds?.length ?? 0)} gambar diterima. ` +
      (draft.pendingImageFileIds?.length ? 'Gambar lain masih diperiksa.' : 'Tekan Selesai tambah gambar jika sudah.'),
      imageKeyboard(draft),
    );
    const max = draft.maxReferenceSeconds ?? 30;
    const text = draft.step === 'video'
      ? `Genjutsu · Paket ${max} detik: kirim 1 video sumber berdurasi 3–${max} detik, maksimal 19MB.`
      : draft.step === 'confirm'
          ? 'Video dan foto sudah siap. Tekan Generate untuk mulai; prompt dibuat otomatis.'
          : 'Input Genjutsu sedang diperiksa atau diproses. Tunggu sebentar.';
    return ctx.reply(text, keyboard(draft.step === 'confirm' ? draft : undefined, deps.price(max)));
  }

  async function video(ctx: any, file: GenjutsuFile) {
    const userId = ctx.from.id, draft = deps.get(userId);
    if (!draft) return;
    if (draft.step !== 'video') return message(ctx);
    const max = draft.maxReferenceSeconds ?? 30;
    if (file.file_size && file.file_size > maxBytes) {
      return ctx.reply('Video maksimal 19MB. Kirim video yang lebih kecil.', keyboard());
    }
    deps.set(userId, { ...draft, step: 'checking_video' });
    try {
      const duration = await deps.inspectVideo(ctx, file);
      if (!Number.isFinite(duration) || duration < 3 || duration > max) throw Error('INVALID_VIDEO');
      const current = deps.get(userId);
      if (current?.id !== draft.id || current.step !== 'checking_video') return;
      deps.set(userId, {
        ...current, step: 'image',
        video: { fileId: file.file_id, mime: file.mime_type ?? 'video/mp4', duration },
      });
      return ctx.reply(
        `Video sumber diterima (${duration.toFixed(1)} detik).\n\n` +
        'Sekarang kirim 1–10 gambar referensi karakter pengganti. Gunakan wajah yang tajam ' +
        'dan jelas, tanpa penutup wajah atau filter berat. Maksimal 19MB per gambar, total seluruh referensi 100MB.\n' +
        'Boleh kirim satu per satu, sebagai album, atau sebagai file gambar. ' +
        'Setelah selesai, tekan Selesai tambah gambar.',
        keyboard(),
      );
    } catch {
      const current = deps.get(userId);
      if (current?.id !== draft.id || current.step !== 'checking_video') return;
      deps.set(userId, { ...current, step: 'video' });
      return ctx.reply(`Video tidak valid. Paket ${max} detik menerima video 3–${max} detik, maksimal 19MB. Saldo belum dipotong.`, keyboard());
    }
  }

  async function image(ctx: any, file: GenjutsuFile) {
    const userId = ctx.from.id, draft = deps.get(userId);
    if (!draft) return;
    if (draft.step !== 'image') return message(ctx);
    const ids = imageIds(draft);
    if (ids.includes(file.file_id)) return ctx.reply('Gambar ini sudah ditambahkan atau sedang diperiksa.', imageKeyboard(draft));
    if (ids.length >= 10) return ctx.reply('Maksimal 10 gambar referensi. Tekan Selesai tambah gambar setelah pemeriksaan selesai.', imageKeyboard(draft));
    if (file.file_size && file.file_size > maxBytes) {
      return ctx.reply('Foto maksimal 19MB. Kirim foto yang lebih kecil.', imageKeyboard(draft));
    }
    // Reserve synchronously so album updates cannot exceed ten slots.
    // Keep reservation order, not completion order, as the reference order.
    deps.set(userId, {
      ...draft, imageFileId: undefined, imageFileIds: [...ids, file.file_id],
      pendingImageFileIds: [...(draft.pendingImageFileIds ?? []), file.file_id],
    });
    let valid = true;
    try {
      await deps.inspectImage(ctx, file);
    } catch {
      valid = false;
    }
    const current = deps.get(userId);
    if (current?.id !== draft.id || current.step !== 'image' || !current.pendingImageFileIds?.includes(file.file_id)) return;
    const ready: GenjutsuDraft = {
      ...current,
      imageFileIds: valid ? imageIds(current) : imageIds(current).filter(id => id !== file.file_id),
      pendingImageFileIds: current.pendingImageFileIds.filter(id => id !== file.file_id),
    };
    deps.set(userId, ready);
    if (!valid) return ctx.reply(
      'Foto tidak bisa dibaca. Kirim gambar JPG, PNG, atau WebP yang valid, maksimal 19MB. Saldo belum dipotong.',
      imageKeyboard(ready),
    );
    return ctx.reply(
      `Gambar referensi diterima (${imageIds(ready).length - ready.pendingImageFileIds!.length}/10).\n` +
      (ready.pendingImageFileIds!.length ? 'Menunggu pemeriksaan gambar lainnya.'
        : 'Kirim gambar tambahan atau tekan Selesai tambah gambar untuk melihat konfirmasi.'),
      imageKeyboard(ready),
    );
  }

  async function confirmImages(ctx: any, draft: GenjutsuDraft) {
    if (draft.pendingImageFileIds?.length) return ctx.reply('Gambar masih diperiksa. Tunggu sebentar sebelum melanjutkan.');
    if (!imageIds(draft).length || imageIds(draft).length > 10) return message(ctx);
    const ready: GenjutsuDraft = { ...draft, step: 'confirm' };
    deps.set(ctx.from.id, ready);
    return ctx.reply(
        `Genjutsu · Character Swap · 1080p\n\n` +
        `Paket: ${ready.maxReferenceSeconds ?? 30} detik\n` +
        `Video sumber: ${ready.video!.duration.toFixed(1)} detik\nGambar referensi: ${imageIds(ready).length}/10\n` +
        'Durasi, rasio, dan audio asli mengikuti video sumber. Video tanpa audio tetap tanpa audio.\n' +
        'Prompt penggantian karakter dibuat otomatis.\n\n' +
        'Foto menjadi acuan wajah dan penampilan; video menjadi acuan gerakan dan adegan. ' +
        'Kemiripan wajah tidak dijamin dan perlu diperiksa pada hasil.\n\n' +
        `Harga: ${deps.price(ready.maxReferenceSeconds ?? 30)} per video. Jika proses gagal, saldo dikembalikan penuh.\n` +
        'Gunakan materi yang diizinkan dan foto orang dengan persetujuannya.\n\nTekan Generate untuk mulai.',
        keyboard(ready, deps.price(ready.maxReferenceSeconds ?? 30)),
      );
  }

  async function callback(ctx: any, data: string) {
    const userId = ctx.from.id;
    if (data === 'mode_genjutsu') {
      const draft: GenjutsuDraft = { id: randomUUID(), step: 'package' };
      deps.set(userId, draft);
      return ctx.editMessageText(
        `Genjutsu · Character Swap · 1080p\n15 detik ${deps.price(15)} · 30 detik ${deps.price(30)}\n\n` +
        'Ganti karakter utama dalam video dengan karakter dari foto referensi.\n' +
        'Gerakan, kamera, dan latar diminta mengikuti video sumber; hasil bergantung pada materi input.\n\n' +
        'Pilih batas durasi referensi: paket 15 detik menerima 3–15 detik, ' +
        'paket 30 detik menerima 3–30 detik. Hasil mengikuti durasi video sumber.\n' +
        'Setelah itu, kirim 1–10 gambar referensi karakter. Tidak perlu menulis prompt.',
        packageKeyboard(draft, deps.price),
      );
    }
    const draft = deps.get(userId);
    if (draft?.step === 'image' && data === `genjutsu_images_done_${draft.id}`) {
      return confirmImages(ctx, draft);
    }
    const selected = /^genjutsu_duration_(15|30)_(.+)$/.exec(data);
    if (selected && draft?.step === 'package' && selected[2] === draft.id) {
      const max = Number(selected[1]) as 15 | 30;
      deps.set(userId, { ...draft, step: 'video', maxReferenceSeconds: max });
      return ctx.editMessageText(
        `Genjutsu · Paket ${max} detik · ${deps.price(max)}\n\nLangkah 1/2: kirim 1 video referensi berdurasi 3–${max} detik, maksimal 19MB.\n` +
        'Durasi hasil mengikuti video sumber. Setelah itu, kirim 1–10 gambar referensi karakter.',
        keyboard(),
      );
    }
    if (!draft || draft.step !== 'confirm' || !draft.video || !imageIds(draft).length
      || imageIds(draft).length > 10 || draft.pendingImageFileIds?.length
      || data !== `genjutsu_generate_${draft.id}`) {
      return ctx.reply('Tombol Genjutsu ini sudah tidak aktif. Gunakan draft yang sedang berjalan atau /menu.');
    }
    // Claim synchronously before any awaited work: a double tap must not bill twice.
    deps.set(userId, { ...draft, step: 'submitting' });
    try {
      return await deps.submit(ctx, draft, GENJUTSU_PROMPT);
    } catch {
      const current = deps.get(userId);
      if (current?.id === draft.id && current.step === 'submitting') {
        deps.set(userId, { ...draft, step: 'confirm' });
      }
      return ctx.reply('Permintaan Genjutsu belum bisa disiapkan. Periksa /saldo dan status proses sebelum mencoba lagi.');
    }
  }

  return { callback, video, image, message };
}
