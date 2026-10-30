import { Markup, type Telegraf } from 'telegraf';
import type { PgDramaStore, DramaProject } from './microdrama-store';
import { episodeProject, newEpisode, referenceNames, type EpisodeProject } from './episode-types';
import { EpisodeEngine, type EpisodeAction } from './episode-engine';
import { EpisodeDirector } from './episode-director';
import { EpisodeMedia } from './episode-media';
import type { EpisodeApi } from './episode-api';
import type { Director } from './episode-director';

const terminal = (p: DramaProject) => ['cancelled', 'failed', 'delivered'].includes(p.status);
const usd = (n: number) => `US$${n.toFixed(4)}`;
const durations = () => Markup.inlineKeyboard([
  [1, 3, 5].map(n => Markup.button.callback(`${n} menit`, `ep:new:${n}`)),
  [10, 15, 20].map(n => Markup.button.callback(`${n} menit`, `ep:new:${n}`)),
]);
export function episodeButtons(p: EpisodeProject) {
  const e = p.episode, rows: any[][] = [], button = (label: string, action: string) => Markup.button.callback(label, `ep:${action}:${p.id}`);
  if (terminal(p)) return durations();
  if (e.busy) rows.push([button('Pulihkan LLM setelah terputus', 'recover')]);
  if (e.phase === 'bible' || e.phase === 'refs_quote') rows.push([button('Estimasi referensi', 'quote_refs'), button('Revisi bible', 'revision')]);
  if (e.phase === 'refs_quote') rows.push([button('Setuju biaya gambar referensi', 'make_refs')]);
  if (e.phase === 'refs_review') rows.push([button('Kunci wajah & lokasi, susun naskah', 'lock_refs')]);
  if (e.phase === 'script' || e.phase === 'production_quote') rows.push([button('Unduh storyboard/naskah', 'script'), button('Estimasi produksi', 'quote')]);
  if (e.phase === 'production_quote') rows.push([button('Setuju anggaran & mulai produksi', 'render')]);
  if (['refs', 'planning', 'production', 'complete'].includes(e.phase)) rows.push([button('Lanjutkan job yang sama', 'resume')]);
  if (e.phase === 'quality_hold') {
    const w = e.shots.find(w => w.accepted === undefined);
    if (w && e.retakes < 2) rows.push([button(`Retake shot ${w.shot.number}`, 'retry')]);
    if (w?.takes.at(-1)?.video.id && w.takes.at(-1)?.transcript) rows.push([button('Terima shot meski ada catatan QA', 'accept')]);
  }
  rows.push([button('Jeda setelah job saat ini', 'pause'), button('Hentikan proyek', 'cancel')]);
  return Markup.inlineKeyboard(rows);
}
export function episodeSummary(p: EpisodeProject) {
  const e = p.episode, done = e.shots.filter(w => w.accepted !== undefined).length;
  let text = `Sutradara episode • khusus admin\n${p.id.slice(0, 8)} • ${e.minutes} menit • 9:16\nTahap: ${e.phase} • status: ${p.status}\nModel sutradara: ${p.model}\n`;
  if (e.bible) text += `\n${e.bible.title}\n${e.bible.synopsis}\n\nGaya: ${e.bible.style}\n` +
    e.bible.cast.map(c => `${c.id} • ${c.name} (${c.age}): ${c.look}\nSuara: ${c.voice}`).join('\n') +
    '\n\nLokasi:\n' + e.bible.locations.map(l => `${l.id}: ${l.description}`).join('\n');
  if (e.phase === 'idea') text += '\nKirim ide cerita (maks. 2.000 karakter). Ide/revisi/perencanaan memakai kuota LLM. Belum ada render media.';
  if (e.phase === 'refs_quote' && e.refQuote && e.bible) text += `\n\nReferensi: ${referenceNames(e.bible).length} gambar + cadangan maksimal 2 gambar ulang.\n` +
    `Batas persetujuan: ${usd(e.refQuote * (referenceNames(e.bible).length + 2))}. Cadangan yang tidak dipakai tidak dikirim.\n`;
  if (e.phase === 'refs_review') text += `\n\nPeriksa gambar yang dikirim. Referensi belum dikunci. Ulangi maksimal dua gambar: /episoderef char_ID atau /episoderef loc_ID. Mengunci akan mulai ${e.minutes * 2} permintaan LLM untuk naskah.`;
  if (e.shots.length) text += `\n\nStoryboard tertulis: ${e.shots.length}/${e.minutes * 6} shot. Video diterima: ${done}/${e.minutes * 6}.\nSetiap shot 10 detik. Kontinuitas wajah memakai referensi terkunci; sambungan last-frame dibatasi dua shot.`;
  if (e.phase === 'production_quote' && e.quote) text += `\n\nBatas produksi: ${usd(e.quote.total)} termasuk gambar storyboard, ${e.shots.length} video, transkripsi, dan maksimal 2 retake otomatis total.\n` +
    `Per video: ${usd(e.quote.video)} • per gambar: ${usd(e.quote.image)} • per transkripsi: ${usd(e.quote.transcript)}.\n` +
    `Di luar anggaran media, pemeriksaan membutuhkan hingga ${e.shots.length * 2 + 4} permintaan LLM (storyboard + video + cadangan retake).\n` +
    'Maksimal satu retake otomatis per shot. Kegagalan/submit ambigu bukan alasan mengirim ulang. Harga diperiksa sebelum setiap submit.\n';
  if (e.refSpent || e.spent) text += `\n\nReservasi konservatif biaya media: referensi ${usd(e.refSpent)}, produksi ${usd(e.spent)}${e.budget ? `/${usd(e.budget)}` : ''}.\nRetake terpakai: ${e.retakes}/2. Permintaan LLM: ${e.llmCalls}.`;
  if (e.phase === 'quality_hold') text += `\n\nPerlu keputusan admin:\n${e.reviewNote}\nTerima meski ada catatan berarti melewati penolakan QA, bukan menyatakan kualitas lulus.`;
  if (p.error) text += `\n\nCatatan: ${p.error}`;
  if (p.status === 'delivered') text += '\n\nEpisode dan subtitle sudah dikirim. Simpan hasilnya segera bila diberikan tautan sementara.';
  text += '\n\nSaldo bot tidak dipotong. Saldo media provider dan kuota LLM digunakan terpisah; anggaran USD di atas bukan batas tagihan LLM. Tidak ada jaminan wajah, suara, dialog atau lip-sync selalu sempurna. Render panjang dapat memerlukan berjam-jam hingga lebih dari sehari, tergantung antrean.';
  if (e.phase === 'refs_quote' || e.phase === 'production_quote') text += '\nPersetujuan estimasi berlaku 10 menit.';
  return text;
}
export function episodeScript(p: EpisodeProject) {
  return `${p.episode.bible!.title}\n${p.episode.minutes} menit • ${p.episode.shots.length} shot\n\n` +
    p.episode.shots.map(w => {
      const s = w.shot;
      return `SHOT ${s.number} • ${(s.number - 1) * 10}–${s.number * 10}s • ADEGAN ${s.scene + 1}\nLokasi ${s.location} • ${s.cast.join(', ')} • ${s.continuation ? 'sambung shot sebelumnya' : 'referensi terkunci'}\n` +
        `Kamera: ${s.camera}\nAksi: ${s.action}\nAwal: ${s.startState}\nAkhir: ${s.endState}\n` +
        s.dialogue.map(d => `${d.speaker}: ${d.text}`).join('\n') +
        `\nPrompt gambar:\n${s.imagePrompt}\nPrompt video:\n${s.videoPrompt}\n`;
    }).join('\n');
}

export function registerEpisode(
  bot: Telegraf<any>, store: PgDramaStore, requireAdmin: (ctx: any) => Promise<boolean>,
  authorized: (owner: number) => Promise<boolean>, api: EpisodeApi,
  deliver: (p: EpisodeProject, files: { video: string; subtitles: string }) => Promise<void>,
  clients: { director?: Director; media?: EpisodeMedia; inspect?: (p: EpisodeProject, shot: number, file: string, note: string) => Promise<void> } = {},
) {
  const input = new Map<number, { id: string; revision: boolean }>();
  async function text(chat: number, value: string, keyboard?: any) {
    for (let i = 0; i < value.length; i += 3500) await bot.telegram.sendMessage(chat, value.slice(i, i + 3500), i + 3500 >= value.length ? keyboard : undefined);
  }
  async function present(p: EpisodeProject) {
    await text(p.chat, episodeSummary(p), episodeButtons(p));
    if (p.episode.phase === 'idea') input.set(p.owner, { id: p.id, revision: false });
  }
  const engine = new EpisodeEngine({ store, api, director: clients.director || new EpisodeDirector(process.env.BUATSIMPEL_API_KEY || ''),
    media: clients.media || new EpisodeMedia(), authorized, deliver, present, inspect: clients.inspect,
    notify: (p, value) => text(p.chat, value),
    preview: async (p, name, bytes) => {
      await bot.telegram.sendPhoto(p.chat, { source: bytes, filename: name + '.jpg' }, { caption: name.startsWith('storyboard_')
        ? `${name}. Storyboard ditolak pemeriksaan visual. Periksa sebelum meminta retake; belum ada video untuk take ini.`
        : `Referensi ${name}. Periksa wajah, pakaian dan lokasi sebelum dikunci.` });
    },
  });
  async function allowed(ctx: any) {
    if (!await requireAdmin(ctx)) return false;
    if (ctx.chat?.type !== 'private') { await ctx.reply('Sutradara episode hanya tersedia di chat pribadi admin.'); return false; }
    if (!store.ready || !process.env.BUATSIMPEL_API_KEY) { await ctx.reply('Sutradara belum siap: periksa penyimpanan dan konfigurasi LLM. Belum ada submit berbayar.'); return false; }
    return true;
  }
  function run(ctx: any, promise: Promise<boolean>) {
    void promise.then(async ok => { if (!ok) await ctx.reply('Proyek sedang berjalan atau bukan milikmu. Gunakan /microdrama untuk melihat progres.'); })
      .catch(async () => { console.warn('Episode operation interrupted; inspect persisted state.'); await ctx.reply('Proses terhenti; periksa /microdrama sebelum melanjutkan.').catch(() => {}); });
  }
  async function current(ctx: any) {
    const p = await store.latest(ctx.from.id);
    if (p && !p.episode && !terminal(p)) { await ctx.reply('Masih ada job prototipe 20 detik. Kelola lewat /microdramatest sebelum membuat episode.'); return undefined; }
    return p?.episode ? episodeProject(p) : undefined;
  }
  async function create(ctx: any, minutes: number) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 20) return ctx.reply('Durasi harus bilangan bulat 1–20 menit. Contoh: /microdrama 7');
    const last = await store.latest(ctx.from.id);
    if (last && !terminal(last)) return last.episode ? present(episodeProject(last)) : ctx.reply('Selesaikan/hentikan prototipe lama melalui /microdramatest.');
    try { await present(episodeProject(await store.create(ctx.from.id, ctx.chat.id, await store.model(ctx.from.id), newEpisode(minutes)))); }
    catch { await ctx.reply('Belum dapat membuat episode. Proyek lama tetap aman; periksa /microdrama.'); }
  }
  bot.use(async (ctx: any, next: any) => {
    if (ctx.from && ((ctx.message?.text?.startsWith('/')) || (ctx.callbackQuery?.data && !ctx.callbackQuery.data.startsWith('ep:')))) input.delete(ctx.from.id);
    return next();
  });
  bot.command(['microdrama', 'microdramastatus', 'episode'], async (ctx: any) => {
    if (!await allowed(ctx)) return;
    const arg = ctx.message.text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
    if (arg) return create(ctx, Number(arg));
    const p = await current(ctx);
    if (p && !terminal(p)) return present(p);
    return ctx.reply('Sutradara AI • episode 1–20 menit, khusus admin.\n\nPilih durasi atau ketik /microdrama 7 untuk durasi lain. Default awal 1 menit.\nBible cerita → persetujuan biaya referensi → kunci wajah/lokasi → storyboard tertulis → persetujuan anggaran → storyboard gambar, video, pemeriksaan visual + transkripsi → penyuntingan.\nBiaya LLM terpisah; belum ada render media tanpa persetujuan.', durations());
  });
  bot.command('episodescript', async (ctx: any) => {
    if (!await allowed(ctx)) return;
    const p = await current(ctx);
    if (p?.episode.shots.length) return bot.telegram.sendDocument(p.chat, { source: Buffer.from(episodeScript(p)), filename: 'storyboard.txt' });
    return ctx.reply('Storyboard tertulis belum selesai.');
  });
  bot.command('episoderef', async (ctx: any) => {
    if (!await allowed(ctx)) return;
    const p = await current(ctx), name = ctx.message.text.replace(/^\/episoderef(?:@\w+)?\s*/, '').trim();
    if (!p || p.episode.phase !== 'refs_review') return ctx.reply('Referensi hanya bisa diulang sebelum dikunci.');
    if (!referenceNames(p.episode.bible!).includes(name)) return ctx.reply('Pilih: ' + referenceNames(p.episode.bible!).join(', '));
    run(ctx, engine.act(p.id, ctx.from.id, 'redo_ref', name));
  });
  bot.action(/^ep:new:(\d{1,2})$/, async (ctx: any) => {
    await ctx.answerCbQuery().catch(() => {});
    if (await allowed(ctx)) return create(ctx, Number(ctx.match[1]));
  });
  bot.action(/^ep:(quote_refs|make_refs|revision|lock_refs|quote|render|resume|recover|retry|accept|cancel|pause|script):([0-9a-f-]{36})$/, async (ctx: any) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!await allowed(ctx)) return;
    input.delete(ctx.from.id);
    const [, action, id] = ctx.match, p = await current(ctx);
    if (!p || p.id !== id) return ctx.reply('Tombol ini bukan proyek aktif milikmu.');
    if (action === 'pause') { await store.requestPause(id, ctx.from.id); return ctx.reply('Permintaan jeda dicatat. Job yang sudah diterima tetap diselesaikan/disimpan; tidak ada submit baru setelah pemeriksaan jeda.'); }
    if (action === 'script') return bot.telegram.sendDocument(p.chat, { source: Buffer.from(episodeScript(p)), filename: 'storyboard.txt' });
    if (action === 'revision') {
      if (!['bible', 'refs_quote'].includes(p.episode.phase)) return;
      input.set(ctx.from.id, { id, revision: true });
      return ctx.reply('Kirim arahan revisi bible (maks. 2.000 karakter). Menggunakan kuota LLM; referensi belum dirender.');
    }
    if (action === 'cancel') await store.requestPause(id, ctx.from.id);
    else if (['resume', 'render', 'make_refs', 'lock_refs', 'retry', 'accept'].includes(action)) await store.requestPause(id, ctx.from.id, false);
    const w = p.episode.shots.find(w => w.accepted === undefined);
    run(ctx, engine.act(id, ctx.from.id, action as EpisodeAction, w ? String(w.shot.number) : ''));
  });
  bot.on('text', async (ctx: any, next: any) => {
    const pending = input.get(ctx.from.id);
    if (!pending || ctx.message.text.startsWith('/')) return next();
    if (!await allowed(ctx)) return;
    const value = ctx.message.text.trim();
    if (!value || value.length > 2000) return ctx.reply('Kirim ide/arahan sepanjang 1–2.000 karakter.');
    input.delete(ctx.from.id);
    run(ctx, engine.act(pending.id, ctx.from.id, pending.revision ? 'revise' : 'write', value));
  });
  return { engine, present };
}
