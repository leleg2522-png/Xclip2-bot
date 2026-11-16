import { randomUUID } from 'node:crypto';

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
}

interface Dependencies {
  get(userId: number): GenjutsuDraft | undefined;
  set(userId: number, draft: GenjutsuDraft): void;
  price(): string;
  inspectVideo(ctx: any, file: GenjutsuFile): Promise<number>;
  inspectImage(ctx: any, file: GenjutsuFile): Promise<void>;
  submit(ctx: any, draft: GenjutsuDraft, prompt: string): Promise<unknown>;
}

const maxBytes = 19 * 1024 * 1024;
function keyboard(draft?: GenjutsuDraft, price?: string) {
  return { reply_markup: { inline_keyboard: [
    ...(draft ? [[{ text: `Generate · ${price}`, callback_data: `genjutsu_generate_${draft.id}` }]] : []),
    [{ text: 'Batal · Menu Utama', callback_data: 'back_main' }],
  ] } };
}

function packageKeyboard(draft: GenjutsuDraft) {
  return { reply_markup: { inline_keyboard: [
    [{ text: 'Paket 15 detik · Referensi 3–15 detik', callback_data: `genjutsu_duration_15_${draft.id}` }],
    [{ text: 'Paket 30 detik · Referensi 3–30 detik', callback_data: `genjutsu_duration_30_${draft.id}` }],
    [{ text: 'Batal · Menu Utama', callback_data: 'back_main' }],
  ] } };
}

/** Separate wizard; never takes a prompt or media from a regular Flash draft. */
export function createGenjutsuFlow(deps: Dependencies) {
  async function message(ctx: any) {
    const draft = deps.get(ctx.from.id);
    if (!draft) return;
    if (draft.step === 'package') return ctx.reply('Pilih paket durasi video referensi Genjutsu.', packageKeyboard(draft));
    const max = draft.maxReferenceSeconds ?? 30;
    const text = draft.step === 'video'
      ? `Genjutsu · Paket ${max} detik: kirim 1 video sumber berdurasi 3–${max} detik, maksimal 19MB.`
      : draft.step === 'image'
        ? 'Genjutsu: kirim 1 foto karakter pengganti, maksimal 19MB.'
        : draft.step === 'confirm'
          ? 'Video dan foto sudah siap. Tekan Generate untuk mulai; prompt dibuat otomatis.'
          : 'Input Genjutsu sedang diperiksa atau diproses. Tunggu sebentar.';
    return ctx.reply(text, keyboard(draft.step === 'confirm' ? draft : undefined, deps.price()));
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
        'Sekarang kirim 1 foto karakter pengganti: satu wajah yang tajam, cukup besar, ' +
        'menghadap depan atau sedikit menyamping, tanpa penutup wajah atau filter berat. Maksimal 19MB.\n' +
        'Boleh kirim sebagai file gambar agar kualitas aslinya tetap terjaga.',
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
    if (file.file_size && file.file_size > maxBytes) {
      return ctx.reply('Foto maksimal 19MB. Kirim foto yang lebih kecil.', keyboard());
    }
    deps.set(userId, { ...draft, step: 'checking_image' });
    try {
      await deps.inspectImage(ctx, file);
      const current = deps.get(userId);
      if (current?.id !== draft.id || current.step !== 'checking_image') return;
      const ready: GenjutsuDraft = { ...current, imageFileId: file.file_id, step: 'confirm' };
      deps.set(userId, ready);
      return ctx.reply(
        `Genjutsu · Character Swap · 1080p\n\n` +
        `Paket: ${ready.maxReferenceSeconds ?? 30} detik\n` +
        `Video sumber: ${ready.video!.duration.toFixed(1)} detik\nFoto karakter: 1\n` +
        'Durasi, rasio, dan audio asli mengikuti video sumber. Video tanpa audio tetap tanpa audio.\n' +
        'Prompt penggantian karakter dibuat otomatis.\n\n' +
        'Foto menjadi acuan wajah dan penampilan; video menjadi acuan gerakan dan adegan. ' +
        'Kemiripan wajah tidak dijamin dan perlu diperiksa pada hasil.\n\n' +
        `Harga: ${deps.price()} per video. Jika proses gagal, saldo dikembalikan penuh.\n` +
        'Gunakan materi yang diizinkan dan foto orang dengan persetujuannya.\n\nTekan Generate untuk mulai.',
        keyboard(ready, deps.price()),
      );
    } catch {
      const current = deps.get(userId);
      if (current?.id !== draft.id || current.step !== 'checking_image') return;
      deps.set(userId, { ...current, step: 'image' });
      return ctx.reply('Foto tidak bisa dibaca. Kirim gambar JPG, PNG, atau WebP yang valid, maksimal 19MB. Saldo belum dipotong.', keyboard());
    }
  }

  async function callback(ctx: any, data: string) {
    const userId = ctx.from.id;
    if (data === 'mode_genjutsu') {
      const draft: GenjutsuDraft = { id: randomUUID(), step: 'package' };
      deps.set(userId, draft);
      return ctx.editMessageText(
        `Genjutsu · Character Swap · 1080p · ${deps.price()}\n\n` +
        'Ganti karakter utama dalam video dengan karakter dari foto referensi.\n' +
        'Gerakan, kamera, dan latar diminta mengikuti video sumber; hasil bergantung pada materi input.\n\n' +
        'Pilih batas durasi referensi: paket 15 detik menerima 3–15 detik, ' +
        'paket 30 detik menerima 3–30 detik. Hasil mengikuti durasi video sumber.\n' +
        'Setelah itu, kirim 1 foto karakter. Tidak perlu menulis prompt.',
        packageKeyboard(draft),
      );
    }
    const draft = deps.get(userId);
    const selected = /^genjutsu_duration_(15|30)_(.+)$/.exec(data);
    if (selected && draft?.step === 'package' && selected[2] === draft.id) {
      const max = Number(selected[1]) as 15 | 30;
      deps.set(userId, { ...draft, step: 'video', maxReferenceSeconds: max });
      return ctx.editMessageText(
        `Genjutsu · Paket ${max} detik\n\nLangkah 1/2: kirim 1 video referensi berdurasi 3–${max} detik, maksimal 19MB.\n` +
        'Durasi hasil mengikuti video sumber. Setelah itu, kirim 1 foto karakter.',
        keyboard(),
      );
    }
    if (!draft || draft.step !== 'confirm' || !draft.video || !draft.imageFileId
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
