import { randomUUID } from 'node:crypto';
import { Markup } from 'telegraf';
import {
  POSBOT_SEEDANCE25_MAX_IMAGES_I2V,
  POSBOT_SEEDANCE25_MAX_IMAGES_R2V,
  POSBOT_SEEDANCE25_MAX_MEDIA_BYTES,
  POSBOT_SEEDANCE25_MAX_PROMPT,
  POSBOT_SEEDANCE25_MAX_TOTAL_BYTES,
  POSBOT_SEEDANCE25_PRICE,
  type PosbotSeedance25Mode,
  type PosbotSeedance25Ratio,
} from './posbot-seedance25';

export type PosbotSeedance25BotMode =
  | 'posbot_s25_wait_ratio'
  | 'posbot_s25_wait_media'
  | 'posbot_s25_wait_prompt';
export type PosbotSeedance25Reference = {
  kind: 'image' | 'video';
  fileId: string;
  size: number;
  order: number;
  duration?: number;
};
type PendingReference = { kind: 'image' | 'video'; fileId: string; size: number; order: number };
export type PosbotSeedance25Draft = {
  id: string;
  mode: PosbotSeedance25Mode;
  ratio?: PosbotSeedance25Ratio;
  refs: PosbotSeedance25Reference[];
  pending: PendingReference[];
};
export type PosbotSeedance25Job = {
  userId: number;
  dbUserId: number;
  chatId: number;
  statusMsgId: number;
  mode: PosbotSeedance25Mode;
  ratio: PosbotSeedance25Ratio;
  prompt: string;
  refs: PosbotSeedance25Reference[];
};

const ratios: PosbotSeedance25Ratio[] = ['9:16', '16:9', '1:1'];
const label = (mode: PosbotSeedance25Mode) => `Seedance 2.5 P3 ${mode.toUpperCase()}`;
const mediaKeyboard = (id: string) => Markup.inlineKeyboard([
  [Markup.button.callback('Selesai input · Lanjut ke prompt', `pb25_done:${id}`)],
  [Markup.button.callback('Batal · Menu Utama', 'back_main')],
]);

export function createPosbotSeedance25Bot(deps: {
  getSession(id: number): { mode: string; dbUserId?: number; posbotSeedance25Draft?: PosbotSeedance25Draft };
  setSession(id: number, patch: {
    mode: PosbotSeedance25BotMode | 'idle';
    posbotSeedance25Draft?: PosbotSeedance25Draft;
    generationDraft?: boolean;
    generationDraftKind?: any;
  }): void;
  available(): boolean;
  price(): number;
  download(fileId: string, maxBytes: number): Promise<Buffer>;
  inspect(bytes: Buffer, kind: 'image' | 'video'): Promise<{ duration?: number; width?: number; height?: number }>;
  run(job: PosbotSeedance25Job): Promise<void>;
  failed(): void;
}) {
  function active(userId: number, id: string, mode: PosbotSeedance25BotMode) {
    const state = deps.getSession(userId);
    return state.mode === mode && state.posbotSeedance25Draft?.id === id
      ? state.posbotSeedance25Draft : undefined;
  }

  async function callback(ctx: any, data: string) {
    const userId = ctx.from.id;
    const selectedMode = data === 'mode_posbot_s25_i2v' ? 'i2v'
      : data === 'mode_posbot_s25_r2v' ? 'r2v' : undefined;
    if (selectedMode) {
      if (!deps.available()) return ctx.reply('Seedance 2.5 P3 sementara belum tersedia. Coba lagi nanti.');
      const draft: PosbotSeedance25Draft = { id: randomUUID(), mode: selectedMode, refs: [], pending: [] };
      deps.setSession(userId, { mode: 'posbot_s25_wait_ratio', posbotSeedance25Draft: draft });
      return ctx.editMessageText(
        `${label(selectedMode)} · 30 detik\nHarga Rp${deps.price().toLocaleString('id-ID')} per video.\n\nPilih rasio:`,
        Markup.inlineKeyboard([
          ...ratios.map(ratio => [Markup.button.callback(ratio, `pb25_ratio_${ratio.replace(':', '')}:${draft.id}`)]),
          [Markup.button.callback('Batal · Menu Utama', 'back_main')],
        ]),
      );
    }

    const [action, id] = data.split(':');
    const state = deps.getSession(userId);
    const draft = state.posbotSeedance25Draft;
    if (!draft || draft.id !== id) return ctx.reply('Pilihan sudah tidak aktif. Mulai lagi dari /menu.');

    if (action.startsWith('pb25_ratio_')) {
      const ratioKey = action.slice('pb25_ratio_'.length);
      const ratio = ratios.find(item => item.replace(':', '') === ratioKey);
      if (state.mode !== 'posbot_s25_wait_ratio' || !ratio) {
        return ctx.reply('Pilihan rasio sudah tidak aktif. Mulai lagi dari /menu.');
      }
      deps.setSession(userId, { mode: 'posbot_s25_wait_media', posbotSeedance25Draft: { ...draft, ratio } });
      const instruction = draft.mode === 'i2v'
        ? 'Kirim 1–2 foto JPG/PNG sebagai frame acuan, lalu tekan Selesai input.'
        : 'Kirim 1 video MP4/WebM sebagai referensi. Opsional: tambahkan maksimal 9 foto karakter/objek, lalu tekan Selesai input.';
      return ctx.editMessageText(
        `${label(draft.mode)} · 30 detik · ${ratio}\n\n${instruction}\n` +
        `Maksimal 19 MB per file dan 100 MB total. Video maksimal 30 detik.\n/menu untuk batal.`,
        mediaKeyboard(draft.id),
      );
    }

    if (action === 'pb25_done') {
      if (state.mode !== 'posbot_s25_wait_media') return ctx.reply('Pilihan sudah tidak aktif.');
      if (draft.pending.length) return ctx.reply('Referensi masih diperiksa. Tunggu sebentar.');
      const imageCount = draft.refs.filter(ref => ref.kind === 'image').length;
      const hasVideo = draft.refs.some(ref => ref.kind === 'video');
      if (draft.mode === 'i2v' && (imageCount < 1 || imageCount > POSBOT_SEEDANCE25_MAX_IMAGES_I2V)) {
        return ctx.reply('Seedance 2.5 P3 I2V membutuhkan 1–2 foto acuan.');
      }
      if (draft.mode === 'r2v' && !hasVideo) return ctx.reply('Kirim satu video referensi sebelum lanjut.');
      deps.setSession(userId, { mode: 'posbot_s25_wait_prompt', posbotSeedance25Draft: draft });
      return ctx.editMessageText(
        `Referensi diterima: ${imageCount} foto${hasVideo ? ' dan 1 video' : ''}.\n\n` +
        `Kirim prompt video (3–${POSBOT_SEEDANCE25_MAX_PROMPT.toLocaleString('id-ID')} karakter).`,
      );
    }
    return ctx.reply('Pilihan sudah tidak aktif. Ikuti langkah yang sedang berjalan.');
  }

  async function addReference(ctx: any, kind: 'image' | 'video', file: any, draft: PosbotSeedance25Draft) {
    const userId = ctx.from.id;
    const fileId = String(file.file_id ?? '');
    const state = deps.getSession(userId);
    const current = state.posbotSeedance25Draft;
    if (!fileId || !current || current.id !== draft.id || state.mode !== 'posbot_s25_wait_media') return;
    if (draft.refs.some(ref => ref.fileId === fileId) || draft.pending.some(ref => ref.fileId === fileId)) {
      return ctx.reply('File ini sudah diterima atau sedang diperiksa.');
    }
    if (kind === 'video' && (draft.mode !== 'r2v' || draft.refs.some(ref => ref.kind === 'video')
      || draft.pending.some(ref => ref.kind === 'video'))) {
      return ctx.reply('Mode R2V menerima satu video referensi.');
    }
    if (kind === 'image' && draft.mode === 'i2v'
      && draft.refs.filter(ref => ref.kind === 'image').length + draft.pending.filter(ref => ref.kind === 'image').length
        >= POSBOT_SEEDANCE25_MAX_IMAGES_I2V) {
      return ctx.reply('Mode I2V menerima maksimal 2 foto.');
    }
    if (kind === 'image' && draft.mode === 'r2v'
      && draft.refs.filter(ref => ref.kind === 'image').length + draft.pending.filter(ref => ref.kind === 'image').length
        >= POSBOT_SEEDANCE25_MAX_IMAGES_R2V) {
      return ctx.reply(`Mode R2V menerima maksimal ${POSBOT_SEEDANCE25_MAX_IMAGES_R2V} foto.`);
    }
    const declaredSize = Number(file.file_size ?? 0);
    if (declaredSize > POSBOT_SEEDANCE25_MAX_MEDIA_BYTES) return ctx.reply('Maksimal 19 MB per file.');
    const pending: PendingReference = {
      kind, fileId, size: declaredSize, order: Number(ctx.message.message_id ?? Date.now()),
    };
    deps.setSession(userId, {
      mode: 'posbot_s25_wait_media',
      posbotSeedance25Draft: { ...draft, pending: [...draft.pending, pending] },
    });

    let bytes: Buffer;
    let metadata: { duration?: number; width?: number; height?: number };
    try {
      bytes = await deps.download(fileId, POSBOT_SEEDANCE25_MAX_MEDIA_BYTES);
      if (!bytes.length || bytes.length > POSBOT_SEEDANCE25_MAX_MEDIA_BYTES) throw Error('FILE_TOO_LARGE');
      metadata = await deps.inspect(bytes, kind);
      if (kind === 'video' && (!Number.isFinite(metadata.duration) || metadata.duration! <= 0
        || metadata.duration! > 30 || !metadata.width || !metadata.height
        || Math.min(metadata.width, metadata.height) < 340)) throw Error('VIDEO_LIMIT');
    } catch (error: any) {
      const latest = active(userId, draft.id, 'posbot_s25_wait_media');
      if (latest) {
        deps.setSession(userId, {
          mode: 'posbot_s25_wait_media',
          posbotSeedance25Draft: { ...latest, pending: latest.pending.filter(ref => ref.fileId !== fileId) },
        });
      }
      return ctx.reply(kind === 'video'
        ? 'Video harus valid, minimal 340×340, maksimal 30 detik dan 19 MB. Kirim MP4/WebM.'
        : 'Foto tidak valid. Gunakan JPG/PNG maksimal 19 MB.');
    }

    const latest = active(userId, draft.id, 'posbot_s25_wait_media');
    if (!latest) return;
    const bytesInUse = latest.refs.reduce((sum, ref) => sum + ref.size, 0)
      + latest.pending.reduce((sum, ref) => sum + (ref.fileId === fileId ? 0 : ref.size), 0);
    if (bytesInUse + bytes.length > POSBOT_SEEDANCE25_MAX_TOTAL_BYTES) {
      deps.setSession(userId, {
        mode: 'posbot_s25_wait_media',
        posbotSeedance25Draft: { ...latest, pending: latest.pending.filter(ref => ref.fileId !== fileId) },
      });
      return ctx.reply('Ukuran gabungan referensi maksimal 100 MB.');
    }
    const refs = [...latest.refs, {
      kind, fileId, size: bytes.length, order: pending.order, ...(metadata.duration ? { duration: metadata.duration } : {}),
    }].sort((a, b) => a.order - b.order);
    deps.setSession(userId, {
      mode: 'posbot_s25_wait_media',
      posbotSeedance25Draft: { ...latest, refs, pending: latest.pending.filter(ref => ref.fileId !== fileId) },
    });
    const summary = `Referensi diterima: ${refs.filter(ref => ref.kind === 'image').length} foto` +
      `${refs.some(ref => ref.kind === 'video') ? ' dan 1 video' : ''}.`;
    return ctx.reply(`${summary} ${draft.mode === 'i2v' ? 'Kirim foto lain atau tekan Selesai input.' : 'Kirim foto opsional lain atau tekan Selesai input.'}`,
      mediaKeyboard(draft.id));
  }

  async function submit(ctx: any, text: string, draft: PosbotSeedance25Draft) {
    const userId = ctx.from.id;
    const current = active(userId, draft.id, 'posbot_s25_wait_prompt');
    const state = deps.getSession(userId);
    if (!current || !state.dbUserId || !current.ratio) return ctx.reply('Sesi tidak lengkap. Mulai lagi dari /menu.');
    const prompt = text.trim();
    if (prompt.length < 3 || prompt.length > POSBOT_SEEDANCE25_MAX_PROMPT) {
      return ctx.reply(`Prompt harus berisi 3–${POSBOT_SEEDANCE25_MAX_PROMPT.toLocaleString('id-ID')} karakter.`);
    }
    if (current.mode === 'i2v' && !current.refs.some(ref => ref.kind === 'image')) {
      return ctx.reply('Foto acuan I2V belum ada. Mulai lagi dari /menu.');
    }
    if (current.mode === 'r2v' && !current.refs.some(ref => ref.kind === 'video')) {
      return ctx.reply('Video acuan R2V belum ada. Mulai lagi dari /menu.');
    }
    const job: PosbotSeedance25Job = {
      userId, dbUserId: state.dbUserId, chatId: ctx.chat.id, statusMsgId: 0,
      mode: current.mode, ratio: current.ratio, prompt, refs: [...current.refs],
    };
    // Claim the draft before any await so repeated prompts cannot charge twice.
    deps.setSession(userId, {
      mode: 'idle', posbotSeedance25Draft: undefined,
      generationDraft: false, generationDraftKind: undefined,
    });
    const status = await ctx.reply(`${label(current.mode)} · 30 detik sedang diproses. Hasil dikirim otomatis.`);
    job.statusMsgId = status.message_id;
    void deps.run(job).catch(deps.failed);
  }

  async function message(ctx: any) {
    const userId = ctx.from.id;
    const state = deps.getSession(userId);
    const draft = state.posbotSeedance25Draft;
    if (!draft) return ctx.reply('Sesi tidak lengkap. Mulai lagi dari /menu.');
    if (state.mode === 'posbot_s25_wait_prompt') {
      if (typeof ctx.message.text !== 'string') return ctx.reply('Kirim prompt video sebagai teks.');
      return submit(ctx, ctx.message.text, draft);
    }
    if (state.mode !== 'posbot_s25_wait_media') return ctx.reply('Pilih rasio video terlebih dahulu.');
    if (draft.pending.length) return ctx.reply('Referensi masih diperiksa. Tunggu sebentar.');

    const msg = ctx.message;
    if (msg.photo?.length) return addReference(ctx, 'image', msg.photo[msg.photo.length - 1], draft);
    if (msg.video) return addReference(ctx, 'video', msg.video, draft);
    if (msg.document) {
      const doc = msg.document;
      if (doc.mime_type?.startsWith('image/') || /\.(jpe?g|png)$/i.test(doc.file_name ?? '')) {
        return addReference(ctx, 'image', doc, draft);
      }
      if (doc.mime_type?.startsWith('video/') || /\.(mp4|webm)$/i.test(doc.file_name ?? '')) {
        return addReference(ctx, 'video', doc, draft);
      }
    }
    return ctx.reply(draft.mode === 'i2v'
      ? 'Kirim foto JPG/PNG, maksimal 2 foto, lalu tekan Selesai input.'
      : 'Kirim video MP4/WebM dan opsional foto JPG/PNG, lalu tekan Selesai input.',
    mediaKeyboard(draft.id));
  }

  return { callback, message };
}
