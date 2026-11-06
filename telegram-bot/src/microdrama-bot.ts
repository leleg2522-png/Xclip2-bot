import { Markup, type Telegraf } from 'telegraf';
import type { PgDramaStore, DramaProject } from './microdrama-store';
import { MicrodramaWriter } from './microdrama-plan';
import { microdramaLlmKey } from './microdrama-llm';
import type { DramaRenderer } from './microdrama-deapi';
import { FfmpegDramaMedia } from './microdrama-media';
import { MicrodramaEngine } from './microdrama-engine';

const terminal = (p: DramaProject) => ['delivered', 'failed', 'cancelled'].includes(p.status);
const usd = (n: number) => `US$${n.toFixed(6)}`;

export function dramaButtons(p?: DramaProject) {
  const button = (label: string, action: string) => Markup.button.callback(label, `md:${action}:${p!.id}`);
  const rows = [];
  if (!p || terminal(p)) rows.push([Markup.button.callback('Microdrama baru', 'md:new')]);
  if (p && ['draft', 'quoted'].includes(p.status)) {
    rows.push([button('Lihat estimasi biaya', 'quote'), button('Revisi naskah', 'revise')]);
  }
  if (p?.status === 'quoted') rows.push([button('Setuju biaya & render', 'approve')]);
  if (p && ['rendering', 'paused', 'ready'].includes(p.status)) rows.push([button('Lanjutkan job yang sama', 'resume')]);
  if (p && ['writing', 'quoting'].includes(p.status)) rows.push([button('Pulihkan draf setelah restart', 'recover')]);
  if (p && !terminal(p)) rows.push([button('Hentikan proyek', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}

async function sendText(bot: Telegraf<any>, chat: number, text: string, options?: any) {
  // Plain text only: model-generated punctuation must never break Telegram parse_mode.
  for (let start = 0; start < text.length; start += 3500) {
    await bot.telegram.sendMessage(chat, text.slice(start, start + 3500), start + 3500 >= text.length ? options : undefined);
  }
}

export function registerMicrodrama(
  bot: Telegraf<any>, store: PgDramaStore, requireAdmin: (ctx: any) => Promise<boolean>,
  authorized: (owner: number) => Promise<boolean>,
  deliver: (p: DramaProject, video: Buffer) => Promise<string | undefined>,
  clients: { writer?: MicrodramaWriter; renderer: DramaRenderer; media?: FfmpegDramaMedia; commands?: string[] },
) {
  const inputOwners = new Set<number>();
  const writer = clients?.writer || new MicrodramaWriter(microdramaLlmKey());
  const configured = () => Boolean(clients.writer || microdramaLlmKey());
  async function present(p: DramaProject) {
    if (p.episode) { await sendText(bot, p.chat, 'Proyek ini memakai sutradara episode. Buka /microdrama.'); return; }
    let text = `Microdrama admin • ${p.id.slice(0, 8)}\nStatus: ${p.status}\nModel naskah: ${p.model}\n`;
    if (p.plan) {
      text += `\n${p.plan.title}\n${p.plan.synopsis}\n\nKarakter:\n` +
        p.plan.characters.map(c => `${c.name} (${c.age}): ${c.description}`).join('\n') +
        `\n\nLokasi: ${p.plan.setting}\n`;
      p.plan.scenes.forEach((s, i) => {
        text += `\nAdegan ${i + 1} (~10 detik)\n${s.action}\n` +
          s.dialogue.map(d => `${p.plan!.characters.find(c => c.id === d.speaker)!.name}: “${d.text}”`).join('\n') + '\n';
      });
    }
    if (p.status === 'quoted' && p.quotes) {
      text += `\nEstimasi render: ${p.quotes.map(usd).join(' + ')} = ${usd(p.quotes.reduce((a, b) => a + b, 0))}.\n` +
        'Persetujuan berlaku 10 menit. Quote adegan 2 memakai gambar contoh berukuran sama; harga gambar asli dicek lagi dan submit dihentikan bila naik.\n' +
        'Biaya ini memakai saldo akun provider, bukan saldo bot. Kuota LLM terpisah. Biaya provider yang sudah dipakai tidak otomatis dikembalikan bila klip berikutnya gagal.\n';
    }
    if (p.status === 'idea') text += '\nKirim ide cerita (maks. 1.500 karakter). Pesan berikutnya memakai kuota LLM. Belum ada render video.';
    if (p.status === 'revision') text += '\nKirim arahan revisi (maks. 1.500 karakter). Revisi memakai kuota LLM lagi; belum ada render video.';
    if (p.status === 'delivered') text += '\nVideo sudah dikirim. 9:16, sekitar 20 detik, native audio; 756×1344 tanpa upscale.';
    if (p.error) text += `\nCatatan: ${p.error}`;
    await sendText(bot, p.chat, text, dramaButtons(p));
    if (p.status === 'idea' || p.status === 'revision') inputOwners.add(p.owner);
  }
  const engine = new MicrodramaEngine({
    store, writer, renderer: clients.renderer,
    media: clients?.media || new FfmpegDramaMedia(), authorized, deliver, present,
    notify: (p, text) => sendText(bot, p.chat, text),
  });

  async function allowed(ctx: any) {
    if (!await requireAdmin(ctx)) return false;
    if (ctx.chat?.type !== 'private') { await ctx.reply('Microdrama admin hanya tersedia di chat pribadi bot.'); return false; }
    if (!configured()) {
      await ctx.reply('Microdrama belum dikonfigurasi: BOTELEX_API_KEY harus tersedia di environment bot. Key video DeAPI dikelola lewat /deapipool di database.');
      return false;
    }
    if (!store.ready) {
      await ctx.reply('Penyimpanan microdrama belum siap. Fitur lain tidak berubah; microdrama tidak akan mengirim permintaan berbayar.');
      return false;
    }
    return true;
  }
  function background(ctx: any, job: Promise<boolean>) {
    void job.then(async ok => {
      if (!ok) await ctx.reply('Proyek atau slot microdrama sedang sibuk, atau tombol ini bukan milik akunmu. /microdrama untuk melihat status.');
    }).catch(async () => {
      // No raw provider/PG errors or credentials in chat/logs.
      console.warn('Microdrama operation interrupted; inspect persisted project state.');
      await ctx.reply('Proses terhenti. Gunakan /microdrama untuk memeriksa status sebelum melanjutkan.').catch(() => {});
    });
  }

  bot.use(async (ctx: any, next: any) => {
    const text = ctx.message?.text, data = ctx.callbackQuery?.data;
    if (ctx.from && ((typeof text === 'string' && text.startsWith('/'))
      || (typeof data === 'string' && !data.startsWith('md:')))) inputOwners.delete(ctx.from.id);
    return next();
  });
  bot.command(clients.commands || ['microdrama', 'microdramastatus'], async (ctx: any) => {
    if (!await allowed(ctx)) return;
    const p = await store.latest(ctx.from.id);
    if (p) return present(p);
    return ctx.reply('Microdrama • uji khusus admin\n\nBUAT SIMPEL menulis naskah; MiniMax merender dua adegan berurutan (~20 detik), 9:16, dialog Indonesia, tanpa upscale.\nNaskah dapat direvisi. Render hanya berjalan setelah estimasi biaya disetujui.\nAntrean video bisa memakan puluhan menit. Saldo bot tidak dipotong, tetapi kuota/saldo provider digunakan.', dramaButtons());
  });
  bot.command('microdramamodel', async (ctx: any) => {
    if (!await allowed(ctx)) return;
    const arg = ctx.message.text.replace(/^\/microdramamodel(?:@\w+)?\s*/i, '').trim();
    try {
      const models = await writer.models();
      if (arg) {
        if (!models.includes(arg)) return ctx.reply('Model tidak aktif atau tidak dikenal. Pilih dari daftar /microdramamodel.');
        await store.setModel(ctx.from.id, arg);
        return ctx.reply(`Model untuk proyek baru: ${arg}. Proyek yang sudah ada tetap memakai model sebelumnya.`);
      }
      return sendText(bot, ctx.chat.id, `Model proyek baru: ${await store.model(ctx.from.id)}\n\nAlias aktif menurut gateway:\n${models.join('\n')}\n\nGanti: /microdramamodel NAMA_MODEL\nNama gateway bukan verifikasi identitas model aslinya.`);
    } catch { return ctx.reply('Daftar model belum dapat diperiksa. Tidak ada pergantian model otomatis.'); }
  });
  bot.action('md:new', async (ctx: any) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!await allowed(ctx)) return;
    const last = await store.latest(ctx.from.id);
    if (last && !terminal(last)) return present(last);
    try { return await present(await store.create(ctx.from.id, ctx.chat.id, await store.model(ctx.from.id))); }
    catch { return ctx.reply('Belum bisa membuat proyek baru. /microdrama untuk memeriksa proyek yang aktif.'); }
  });
  bot.action(/^md:(quote|revise|approve|resume|cancel|recover):([0-9a-f-]{36})$/, async (ctx: any) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!await allowed(ctx)) return;
    inputOwners.delete(ctx.from.id);
    const [, action, id] = ctx.match;
    background(ctx, engine.act(id, ctx.from.id, action));
  });
  bot.on('text', async (ctx: any, next: any) => {
    if (!inputOwners.has(ctx.from.id) || ctx.message.text.startsWith('/')) return next();
    if (!await allowed(ctx)) { inputOwners.delete(ctx.from.id); return; }
    const text = ctx.message.text.trim();
    if (!text || text.length > 1500) return ctx.reply('Kirim ide atau arahan revisi sepanjang 1–1.500 karakter.');
    const p = await store.latest(ctx.from.id);
    if (!p || p.episode || !['idea', 'revision'].includes(p.status)) { inputOwners.delete(ctx.from.id); return next(); }
    inputOwners.delete(ctx.from.id);
    background(ctx, engine.act(p.id, ctx.from.id, 'write', text));
  });
  return { engine, present };
}
