import { randomUUID } from 'node:crypto';
import { Markup } from 'telegraf';
import { SEEDANCE25_P2, validateP2References, type P2Ratio, type P2Reference } from './seedance25-edan';
import {
  validateSeedance25Prompt, validateSeedance25TxtDocument, decodeSeedance25Txt,
  SEEDANCE25_MAX_TXT_BYTES,
} from './seedance25-prompt';

export type P2Mode = 's25p2_wait_ratio' | 's25p2_wait_media' | 's25p2_wait_prompt';
export type P2Draft = {
  id: string; ratio?: P2Ratio; refs: P2Reference[];
  pending: { fileId: string; kind: 'image' | 'video' }[];
};
export type P2Job = {
  chatId: number; userId: number; dbUserId: number; statusMsgId: number;
  prompt: string; ratio: P2Ratio; refs: P2Reference[];
};
type State = { mode: string; dbUserId?: number; seedance25P2?: P2Draft };
type Dependencies = {
  getSession(id: number): State;
  setSession(id: number, patch: { mode: P2Mode | 'idle'; seedance25P2?: P2Draft }): void;
  price(): number;
  cooldown(id: number): number;
  download(fileId: string, maxBytes: number): Promise<Buffer>;
  inspect(bytes: Buffer, kind: 'image' | 'video'): Promise<{ duration?: number }>;
  run(job: P2Job): Promise<void>;
};
const inputsKeyboard = (id: string) => Markup.inlineKeyboard([
  [Markup.button.callback('Selesai upload · Lanjut ke prompt', `s25p2_done:${id}`)],
]);
const instructions =
  'Kirim gambar JPG/PNG dan/atau video MP4 sebagai referensi (boleh dicampur). ' +
  'Batas bot: 10 gambar dan 10 video sekaligus; total video 30 detik, minimal 2 detik per video. ' +
  'Maksimal 19MB per file dan 100MB gabungan. Ini referensi, bukan start/end frame.\n' +
  'Tunggu semua file diterima, lalu tekan selesai upload.';

export function createSeedance25P2Bot(deps: Dependencies) {
  async function callback(ctx: any, data: string) {
    const userId = ctx.from.id;
    if (data === 'mode_seedance25_p2') {
      const id = randomUUID();
      deps.setSession(userId, {
        mode: 's25p2_wait_ratio', seedance25P2: { id, refs: [], pending: [] },
      });
      return ctx.editMessageText(
        `${SEEDANCE25_P2.label} · 30 detik · 720p langsung\n` +
        `Harga Rp${deps.price().toLocaleString('id-ID')} per video. Pilih rasio:`,
        Markup.inlineKeyboard(SEEDANCE25_P2.ratios.map(r =>
          [Markup.button.callback(r, `s25p2_ratio_${r.replace(':', '')}:${id}`)])),
      );
    }
    const state = deps.getSession(userId), draft = state.seedance25P2;
    if (data.startsWith('s25p2_ratio_')) {
      const [key, id] = data.slice('s25p2_ratio_'.length).split(':');
      const ratio = SEEDANCE25_P2.ratios.find(r => r.replace(':', '') === key);
      if (state.mode !== 's25p2_wait_ratio' || !draft || draft.id !== id || !ratio) {
        return ctx.reply('Pilihan sudah tidak aktif. Mulai lagi dari /menu.');
      }
      deps.setSession(userId, { mode: 's25p2_wait_media', seedance25P2: { ...draft, ratio } });
      return ctx.editMessageText(`${SEEDANCE25_P2.label} · ${ratio} · 30 detik · 720p\n\n${instructions}`, inputsKeyboard(draft.id));
    }
    if (data.startsWith('s25p2_done')) {
      if (state.mode !== 's25p2_wait_media' || !draft || data !== `s25p2_done:${draft.id}`) return ctx.reply('Pilihan sudah tidak aktif.');
      if (draft.pending.length) return ctx.reply('Referensi masih diperiksa. Tunggu semua file diterima.');
      try { validateP2References(draft.refs); }
      catch (error: any) { return ctx.reply(error.message); }
      deps.setSession(userId, { mode: 's25p2_wait_prompt', seedance25P2: draft });
      return ctx.editMessageText(
        `Referensi diterima: ${draft.refs.filter(r => r.kind === 'image').length} gambar, ` +
        `${draft.refs.filter(r => r.kind === 'video').length} video.\n\n` +
        'Kirim prompt sebagai pesan teks atau file .txt UTF-8 (batas bot 20.000 karakter). /menu untuk batal.',
      );
    }
  }

  function active(userId: number, id: string, mode: P2Mode) {
    const state = deps.getSession(userId);
    return state.mode === mode && state.seedance25P2?.id === id ? state.seedance25P2 : undefined;
  }

  async function media(ctx: any, kind: 'image' | 'video', file: any, draft: P2Draft) {
    const userId = ctx.from.id, id = file.file_id;
    if (!id || draft.refs.some(r => r.fileId === id) || draft.pending.some(r => r.fileId === id)) {
      return ctx.reply('File ini sudah diterima atau sedang diperiksa.');
    }
    const max = kind === 'image' ? SEEDANCE25_P2.maxImages : SEEDANCE25_P2.maxVideos;
    if (draft.refs.filter(r => r.kind === kind).length + draft.pending.filter(r => r.kind === kind).length >= max) {
      return ctx.reply(`Maksimal ${max} referensi ${kind === 'image' ? 'gambar' : 'video'}.`);
    }
    if (file.file_size > SEEDANCE25_P2.maxBytes) return ctx.reply('Maksimal 19MB per file referensi.');
    // Reserve before awaits; concurrent files cannot bypass count limits.
    deps.setSession(userId, {
      mode: 's25p2_wait_media', seedance25P2: { ...draft, pending: [...draft.pending, { fileId: id, kind }] },
    });
    let bytes: Buffer, metadata: { duration?: number };
    try {
      bytes = await deps.download(id, SEEDANCE25_P2.maxBytes);
      if (!bytes.length || bytes.length > SEEDANCE25_P2.maxBytes) throw Error('INVALID_SIZE');
      metadata = await deps.inspect(bytes, kind);
    } catch {
      const current = active(userId, draft.id, 's25p2_wait_media');
      if (!current) return;
      deps.setSession(userId, {
        mode: 's25p2_wait_media', seedance25P2: { ...current, pending: current.pending.filter(p => p.fileId !== id) },
      });
      return ctx.reply('File tidak bisa dibaca. Gunakan gambar JPG/PNG atau video MP4 2–30 detik, maksimal 19MB per file.');
    }
    const current = active(userId, draft.id, 's25p2_wait_media');
    if (!current) return;
    const pending = current.pending.filter(p => p.fileId !== id);
    const refs = [...current.refs, {
      kind, fileId: id, size: bytes.length, duration: metadata.duration, order: ctx.message.message_id,
    }].sort((a, b) => a.order - b.order);
    try { validateP2References(refs); }
    catch (error: any) {
      deps.setSession(userId, { mode: 's25p2_wait_media', seedance25P2: { ...current, pending } });
      return ctx.reply(error.message);
    }
    deps.setSession(userId, { mode: 's25p2_wait_media', seedance25P2: { ...current, refs, pending } });
    return ctx.reply(`Referensi diterima: ${refs.filter(r => r.kind === 'image').length} gambar, ` +
      `${refs.filter(r => r.kind === 'video').length} video.`, inputsKeyboard(draft.id));
  }

  async function submit(ctx: any, text: string, draft: P2Draft) {
    const userId = ctx.from.id;
    const current = active(userId, draft.id, 's25p2_wait_prompt');
    const dbUserId = deps.getSession(userId).dbUserId;
    if (!current || !dbUserId || !current.ratio) return;
    let prompt: string;
    try { prompt = validateSeedance25Prompt(text); validateP2References(current.refs); }
    catch (error: any) { return ctx.reply(error.message); }
    const ms = deps.cooldown(userId);
    if (ms > 0) return ctx.reply(`Tunggu ${Math.ceil(ms / 1000)} detik sebelum generate berikutnya.`);
    const ratio = current.ratio, refs = current.refs.map(r => ({ ...r }));
    // Both plain text and TXT claim this draft once, before any status await.
    deps.setSession(userId, { mode: 'idle', seedance25P2: undefined });
    const status = await ctx.reply(`${SEEDANCE25_P2.label} sedang diproses · 30 detik · 720p.\nHasil dikirim otomatis.`);
    void deps.run({ userId, dbUserId, chatId: ctx.chat.id, statusMsgId: status.message_id, prompt, ratio, refs })
      .catch(() => ctx.reply('Proses tidak dapat diselesaikan. Periksa saldo dan mulai lagi dari /menu.').catch(() => {}));
  }

  async function message(ctx: any) {
    const state = deps.getSession(ctx.from.id), draft = state.seedance25P2;
    if (!draft) return ctx.reply('Sesi tidak lengkap. Mulai lagi dari /menu.');
    const msg = ctx.message;
    if (state.mode === 's25p2_wait_prompt') {
      if (typeof msg.text === 'string') return submit(ctx, msg.text, draft);
      if (msg.document) {
        try { validateSeedance25TxtDocument(msg.document); }
        catch (error: any) { return ctx.reply(error.message); }
        let bytes: Buffer;
        try { bytes = await deps.download(msg.document.file_id, SEEDANCE25_MAX_TXT_BYTES); }
        catch { if (active(ctx.from.id, draft.id, 's25p2_wait_prompt')) return ctx.reply('File TXT tidak bisa dibaca. Kirim ulang UTF-8.'); return; }
        if (!active(ctx.from.id, draft.id, 's25p2_wait_prompt')) return;
        let prompt: string;
        try { prompt = decodeSeedance25Txt(bytes); }
        catch (error: any) { return ctx.reply(error.message); }
        return submit(ctx, prompt, draft);
      }
      return ctx.reply('Kirim prompt teks atau file .txt UTF-8.');
    }
    if (state.mode !== 's25p2_wait_media') return ctx.reply('Pilih rasio dari tombol terlebih dahulu.');
    if (msg.photo?.length) return media(ctx, 'image', msg.photo[msg.photo.length - 1], draft);
    if (msg.video) return media(ctx, 'video', msg.video, draft);
    if (msg.document) {
      const doc = msg.document;
      if (doc.mime_type?.startsWith('image/') || /\.(jpe?g|png)$/i.test(doc.file_name ?? '')) return media(ctx, 'image', doc, draft);
      if (doc.mime_type?.startsWith('video/') || /\.mp4$/i.test(doc.file_name ?? '')) return media(ctx, 'video', doc, draft);
    }
    return ctx.reply(instructions, inputsKeyboard(draft.id));
  }
  return { callback, message };
}
