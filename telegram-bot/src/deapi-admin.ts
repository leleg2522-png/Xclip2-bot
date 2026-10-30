import type { Telegraf } from 'telegraf';
import type { DeapiKeyPool } from './deapi-key-pool';

export function registerDeapiAdmin(bot: Telegraf<any>, pool: DeapiKeyPool, requireAdmin: (ctx: any) => Promise<boolean>) {
  async function allowed(ctx: any) {
    if (!await requireAdmin(ctx)) return false;
    if (ctx.chat?.type !== 'private') { await ctx.reply('Kelola key DeAPI lewat chat pribadi bot.'); return false; }
    return true;
  }
  bot.command('adddeapikey', async (ctx: any) => {
    await ctx.deleteMessage().catch(() => {});
    if (!await allowed(ctx)) return;
    const raw = ctx.message.text.replace(/^\/adddeapikey(?:@\w+)?(?:\s+|$)/i, '').trim();
    if (!raw) return ctx.reply('Format: /adddeapikey KEY\nBisa banyak key, dipisahkan spasi, koma atau baris baru. Maksimal 100 per pesan.\nPesan key akan dihapus setelah dibaca; key tidak ditampilkan kembali.');
    try {
      const keys = [...new Set<string>(raw.split(/[\s,]+/).filter(Boolean))];
      const added = await pool.addKeys(keys);
      return ctx.reply(`Key DeAPI ditambahkan: ${added}\nDuplikat: ${keys.length - added}\nCek /deapipool.`);
    } catch { return ctx.reply('Key belum dapat disimpan. Periksa format atau koneksi database. Nilai key tidak ditampilkan.'); }
  });
  bot.command('deapipool', async (ctx: any) => {
    if (!await allowed(ctx)) return;
    try {
      const stats = await pool.stats(), rows = await pool.list();
      return ctx.reply(`Pool DeAPI • microdrama\nTersedia: ${stats.available}\nNonaktif: ${stats.dead}\n\n` +
        rows.map(r => `ID ${r.id}: ${r.status}`).join('\n') +
        '\n\n/adddeapikey KEY\n/nonaktifdeapikey ID\n/restoredeapikey ID\n\nKey reusable; biaya memakai saldo akun DeAPI. Nonaktif hanya menghentikan pemilihan untuk job baru, bukan polling job lama.');
    } catch { return ctx.reply('Pool DeAPI belum dapat dibaca. Coba lagi nanti.'); }
  });
  for (const [name, restore] of [['nonaktifdeapikey', false], ['restoredeapikey', true]] as const) {
    bot.command(name, async (ctx: any) => {
      if (!await allowed(ctx)) return;
      const raw = ctx.message.text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim(), id = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) return ctx.reply(`Format: /${name} ID`);
      try {
        const changed = restore ? await pool.restore(id) : await pool.disable(id);
        return ctx.reply(changed ? `Key ID ${id} ${restore ? 'diaktifkan' : 'dinonaktifkan'}.` : 'ID key tidak ditemukan.');
      } catch { return ctx.reply('Status key belum dapat diubah. Coba lagi nanti.'); }
    });
  }
}
