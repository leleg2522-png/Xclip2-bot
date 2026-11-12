import type { Telegraf } from 'telegraf';
import type { VivareelKeyPool } from './vivareel-key-pool';

export function registerVivareelAdmin(
  bot: Telegraf<any>, pool: VivareelKeyPool, requireAdmin: (ctx: any) => Promise<boolean>,
) {
  async function allowed(ctx: any) {
    if (!await requireAdmin(ctx)) return false;
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Kelola key lewat chat pribadi bot.');
      return false;
    }
    return true;
  }
  bot.command('addvivareelkey', async (ctx: any) => {
    await ctx.deleteMessage().catch(() => {});
    if (!await allowed(ctx)) return;
    const raw = ctx.message.text.replace(/^\/addvivareelkey(?:@\w+)?(?:\s+|$)/i, '').trim();
    if (!raw) return ctx.reply('Format: /addvivareelkey KEY\nBisa banyak key dipisahkan koma atau baris baru. Nilai key tidak ditampilkan kembali.');
    try {
      const keys = [...new Set<string>(raw.split(/[\s,]+/).filter(Boolean))];
      const added = await pool.addKeys(keys);
      return ctx.reply(`Key ditambahkan: ${added}\nDuplikat: ${keys.length - added}\nCek dengan /vivareelpool.`);
    } catch {
      return ctx.reply('Key belum dapat disimpan. Periksa format atau koneksi database. Nilai key tidak ditampilkan.');
    }
  });
  bot.command('vivareelpool', async (ctx: any) => {
    if (!await allowed(ctx)) return;
    try {
      const stats = await pool.stats();
      const rows = await pool.list();
      return ctx.reply(`Pool Vivareel • Wan 3.0\nTersedia: ${stats.available}\nNonaktif: ${stats.dead}\n\n` +
        rows.map(row => `ID ${row.id}: ${row.status}`).join('\n') +
        '\n\n/addvivareelkey KEY\n/nonaktifvivareelkey ID\n/restorevivareelkey ID');
    } catch { return ctx.reply('Pool belum dapat dibaca. Coba lagi nanti.'); }
  });
  for (const [command, restore] of [['nonaktifvivareelkey', false], ['restorevivareelkey', true]] as const) {
    bot.command(command, async (ctx: any) => {
      if (!await allowed(ctx)) return;
      const raw = ctx.message.text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
      const id = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id < 1) return ctx.reply(`Format: /${command} ID`);
      try {
        const changed = restore ? await pool.restore(id) : await pool.disable(id);
        return ctx.reply(changed ? `Key ID ${id} ${restore ? 'diaktifkan' : 'dinonaktifkan'}.` : 'ID key tidak ditemukan.');
      } catch { return ctx.reply('Status key belum dapat diubah. Coba lagi nanti.'); }
    });
  }
}
