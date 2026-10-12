import { Markup, type Telegraf } from 'telegraf';
import type { ChinaApiKeyPool } from './chinaapi-key-pool';

/** Private admin-only key entry and pool counts, independent of generation drafts. */
export function registerChinaApiAdmin(
  bot: Telegraf<any>, pool: ChinaApiKeyPool, requireAdmin: (ctx: any) => Promise<boolean>,
) {
  const pending = new Map<number, { expires: number; busy: boolean }>();
  const buttons = () => Markup.inlineKeyboard([
    [Markup.button.callback('Tambah API Key', 'china_admin_add')],
    [Markup.button.callback('Cek Jumlah Key', 'china_admin_pool')],
    [Markup.button.callback('Batal', 'china_admin_cancel')],
  ]);
  async function allowed(ctx: any) {
    if (!await requireAdmin(ctx)) return false;
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Kelola API key melalui chat pribadi bot.');
      return false;
    }
    return true;
  }
  function summary(stats: Awaited<ReturnType<ChinaApiKeyPool['stats']>>) {
    const total = stats.available + stats.busy + stats.used + stats.dead;
    return `Pool ChinaAPI • 1 key = 1 percobaan generate\n\nTotal key: ${total}\n` +
      `Tersedia: ${stats.available}\nDicadangkan: ${stats.busy}\nTerpakai sekali: ${stats.used}\nNonaktif: ${stats.dead}`;
  }
  async function showPool(ctx: any) {
    pending.delete(ctx.from.id);
    const stats = await pool.stats();
    const rows = await pool.list();
    return ctx.reply(summary(stats) +
      (rows.length ? '\n\n' + rows.map(row => `ID ${row.id}: ${row.status}${row.busy ? ' (dicadangkan)' : ''}`).join('\n') : '') +
      '\n\n/nonaktifchinakey ID\n/restorechinakey ID', buttons());
  }
  async function begin(ctx: any) {
    pending.set(ctx.from.id, { expires: Date.now() + 10 * 60 * 1000, busy: false });
    return ctx.reply('Kirim API key ChinaAPI di pesan berikutnya.\nBisa satu atau banyak sekaligus, dipisahkan koma, spasi, atau baris baru.\n\nPesan berisi key akan dihapus setelah dibaca; nilai key tidak ditampilkan kembali.\nSatu key hanya untuk satu percobaan generate.', buttons());
  }
  async function insert(ctx: any, raw: string) {
    await ctx.deleteMessage().catch(() => {});
    try {
      const keys = raw.split(/[\s,]+/).filter(Boolean);
      const added = await pool.addKeys(keys);
      const stats = await pool.stats();
      return await ctx.reply(`Ditambahkan: ${added}\nDuplikat: ${keys.length - added}\n\n${summary(stats)}\n\nKirim key lain atau pilih Batal.`, buttons());
    } catch {
      return ctx.reply('Key belum dapat ditambahkan. Periksa format atau koneksi database, lalu coba lagi. Nilai key tidak ditampilkan.', buttons());
    }
  }
  // Register before other handlers: unrelated commands/buttons leave key-entry
  // mode, and credential messages cannot fall through into a generation prompt.
  bot.use(async (ctx: any, next: any) => {
    const id = ctx.from?.id;
    const text = ctx.message?.text;
    const data = ctx.callbackQuery?.data;
    if (id && ((typeof text === 'string' && text.startsWith('/'))
      || (typeof data === 'string' && !data.startsWith('china_admin_')))) pending.delete(id);
    return next();
  });
  bot.on('text', async (ctx: any, next: any) => {
    const entry = pending.get(ctx.from.id);
    if (!entry || ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) return next();
    if (entry.busy) {
      await ctx.deleteMessage().catch(() => {});
      return ctx.reply('Penambahan sebelumnya masih diproses. Kirim ulang key ini setelah selesai.');
    }
    entry.busy = true;
    try {
      if (!await allowed(ctx)) {
        await ctx.deleteMessage().catch(() => {});
        pending.delete(ctx.from.id);
        return;
      }
      if (entry.expires < Date.now()) {
        pending.delete(ctx.from.id);
        await ctx.deleteMessage().catch(() => {});
        return ctx.reply('Sesi tambah key sudah berakhir. Mulai lagi dengan /addchinakey.', buttons());
      }
      await insert(ctx, ctx.message.text.trim());
    } finally {
      entry.busy = false;
    }
  });
  bot.command(['chinaapi', 'chinapool', 'chinaapipool', 'chinaapistatus'], async (ctx: any) => {
    if (await allowed(ctx)) return showPool(ctx);
  });
  bot.command(['addchinakey', 'addchinaapikey'], async (ctx: any) => {
    const raw = ctx.message.text.replace(/^\/(?:addchinakey|addchinaapikey)(?:@\w+)?\s*/i, '').trim();
    if (raw) await ctx.deleteMessage().catch(() => {});
    if (!await allowed(ctx)) return;
    await begin(ctx);
    if (raw) return insert(ctx, raw);
  });
  for (const [action, handler] of [
    ['china_admin_add', begin], ['china_admin_pool', showPool],
    ['china_admin_cancel', async (ctx: any) => {
      pending.delete(ctx.from.id);
      return ctx.reply('Sesi tambah key dibatalkan. /chinaapi untuk membuka pool lagi.');
    }],
  ] as const) {
    bot.action(action, async (ctx: any) => {
      await ctx.answerCbQuery().catch(() => {});
      if (await allowed(ctx)) return handler(ctx);
    });
  }
}
