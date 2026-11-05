import { randomUUID } from 'node:crypto';
import { Markup } from 'telegraf';
import { BUDGET_VIDEO_MODELS, isBudgetVideoModel, type BudgetVideoInput, type BudgetVideoModel, type VideoImage, type VideoRatio } from './budget-video-api';

export type BudgetVideoMode = 'budget_video_ratio' | 'budget_video_image' | 'budget_video_end' | 'budget_video_prompt';
export interface BudgetVideoDraft {
  id: string; model: BudgetVideoModel; ratio?: VideoRatio; images: VideoImage[]; loading?: boolean;
}
export function createBudgetVideoBot(deps: {
  session(id: number): { mode: string; dbUserId?: number; budgetVideo?: BudgetVideoDraft };
  set(id: number, data: any): void;
  download(ctx: any, fileId: string): Promise<VideoImage>;
  run(ctx: any, dbUserId: number, input: BudgetVideoInput, statusId: number): Promise<void>;
  error(error: unknown): void;
}) {
  function active(id: number, token: string) {
    const s = deps.session(id);
    return s.mode.startsWith('budget_video_') && s.budgetVideo?.id === token ? s.budgetVideo : undefined;
  }
  const controls = (draft: BudgetVideoDraft, end: boolean) => Markup.inlineKeyboard([
    ...(end || !BUDGET_VIDEO_MODELS[draft.model].imageRequired
      ? [[Markup.button.callback(end ? 'Tanpa Foto Akhir' : 'Prompt Saja', `bvideo_skip:${draft.id}`)]] : []),
    [Markup.button.callback('Batal · Menu Utama', 'back_main')],
  ]);
  async function callback(ctx: any, data: string) {
    const id = ctx.from.id;
    if (data.startsWith('mode_bvideo_')) {
      const model = data.slice('mode_bvideo_'.length);
      if (!isBudgetVideoModel(model)) return ctx.reply('Model tidak ditemukan. Gunakan /menu.');
      const draft: BudgetVideoDraft = { id: randomUUID(), model, images: [] };
      deps.set(id, { mode: 'budget_video_ratio', budgetVideo: draft });
      const c = BUDGET_VIDEO_MODELS[model];
      return ctx.editMessageText(`${c.label} · ${c.duration} detik · ${c.quality}\nHarga Rp500/video. Gagal generate atau gagal kirim = saldo kembali.\n\nPilih rasio:`,
        Markup.inlineKeyboard([
          ...(['9:16','16:9','1:1'] as const).map(r => [Markup.button.callback(r, `bvideo_ratio_${r.replace(':','')}:${draft.id}`)]),
          [Markup.button.callback('Batal · Menu Utama', 'back_main')],
        ]));
    }
    const [action, token] = data.split(':');
    const draft = active(id, token);
    if (!draft) return ctx.reply('Tombol ini sudah tidak aktif. Gunakan /menu.');
    if (draft.loading) return ctx.reply('Foto masih diperiksa. Tunggu sebentar.');
    if (action.startsWith('bvideo_ratio_') && deps.session(id).mode === 'budget_video_ratio') {
      const ratio = ({ '916':'9:16', '169':'16:9', '11':'1:1' } as const)[action.slice('bvideo_ratio_'.length) as '916'];
      if (!ratio) return;
      deps.set(id, { mode: 'budget_video_image', budgetVideo: { ...draft, ratio } });
      return ctx.editMessageText('Kirim foto awal JPG/PNG/WebP, maksimal 10 MB.' +
        (BUDGET_VIDEO_MODELS[draft.model].imageRequired ? '' : '\nAtau pilih Prompt Saja untuk text-to-video.'), controls(draft, false));
    }
    if (action === 'bvideo_skip' && (deps.session(id).mode === 'budget_video_end'
      || (deps.session(id).mode === 'budget_video_image' && !BUDGET_VIDEO_MODELS[draft.model].imageRequired))) {
      deps.set(id, { mode: 'budget_video_prompt' });
      return ctx.editMessageText('Kirim prompt videonya sebagai pesan teks (maksimal 20.000 karakter). /menu untuk batal.');
    }
    return ctx.reply('Pilihan sudah tidak aktif. Ikuti langkah yang sedang berjalan.');
  }
  async function message(ctx: any) {
    const id = ctx.from.id, session = deps.session(id), draft = session.budgetVideo;
    if (!draft) return ctx.reply('Draft tidak ditemukan. Gunakan /menu.');
    const msg = ctx.message;
    if (draft.loading) return ctx.reply('Foto masih diperiksa. Tunggu sebentar.');
    if (session.mode === 'budget_video_image' || session.mode === 'budget_video_end') {
      const file = msg.photo?.at(-1) ?? msg.document;
      if (!file || (msg.document && !['image/jpeg','image/png','image/webp'].includes(msg.document.mime_type))) {
        return ctx.reply('Kirim foto JPG/PNG/WebP, maksimal 10 MB.');
      }
      if (file.file_size > 10 * 1024 * 1024) return ctx.reply('Foto maksimal 10 MB.');
      deps.set(id, { budgetVideo: { ...draft, loading: true } });
      let image: VideoImage;
      try { image = await deps.download(ctx, file.file_id); }
      catch {
        if (active(id, draft.id)) deps.set(id, { budgetVideo: { ...draft, loading: false } });
        return ctx.reply('Foto tidak bisa dibaca. Gunakan JPG/PNG/WebP maksimal 10 MB.');
      }
      if (!active(id, draft.id)) return;
      const next = { ...draft, loading: false, images: [...draft.images, image] };
      const wantEnd = BUDGET_VIDEO_MODELS[draft.model].endFrame && next.images.length === 1;
      deps.set(id, { mode: wantEnd ? 'budget_video_end' : 'budget_video_prompt', budgetVideo: next });
      return ctx.reply(wantEnd ? 'Foto awal diterima. Kirim foto akhir opsional, atau pilih Tanpa Foto Akhir.'
        : 'Foto diterima. Kirim prompt videonya (maksimal 20.000 karakter). /menu untuk batal.',
      wantEnd ? controls(next, true) : undefined);
    }
    if (session.mode !== 'budget_video_prompt') return ctx.reply('Pilih rasio terlebih dahulu.');
    const prompt = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!prompt || prompt.length > 20_000) return ctx.reply('Kirim prompt teks 1–20.000 karakter.');
    if (!session.dbUserId || !draft.ratio) return ctx.reply('Akun atau draft belum siap. Gunakan /menu.');
    const input: BudgetVideoInput = { model: draft.model, ratio: draft.ratio, prompt, images: draft.images };
    // Clear synchronously before the first await: duplicate prompts cannot submit twice.
    deps.set(id, { mode: 'idle', budgetVideo: undefined, generationDraft: false, generationDraftKind: undefined });
    const status = await ctx.reply('Memproses video. Harga Rp500; hasil akan dikirim otomatis.');
    void deps.run(ctx, session.dbUserId, input, status.message_id).catch(deps.error);
  }
  return { callback, message };
}

export async function executeBudgetVideoOrder(input: BudgetVideoInput, deps: {
  charge(): Promise<{ ok: true } | { ok: false; reason: 'busy' | 'insufficient' | 'error' }>;
  rejected(reason: 'busy' | 'insufficient' | 'error'): Promise<void>;
  generate(): Promise<string>; deliver(url: string): Promise<boolean>;
  refund(): Promise<void>; refunded(): Promise<void>; failed(error: unknown): Promise<void>;
  release(): void;
}) {
  const charge = await deps.charge();
  if (!charge.ok) { await deps.rejected(charge.reason); return; }
  let delivered = false;
  try {
    delivered = await deps.deliver(await deps.generate());
    if (!delivered) throw Error('VIDEO_DELIVERY_FAILED');
  } catch (error) { await deps.failed(error); }
  finally {
    try {
      if (!delivered) { await deps.refund(); await deps.refunded(); }
    } finally { deps.release(); }
  }
}
