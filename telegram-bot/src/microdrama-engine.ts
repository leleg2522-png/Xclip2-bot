import { scenePrompt, type BuatSimpelWriter } from './microdrama-plan';
import type { DramaRenderer } from './microdrama-deapi';
import type { DramaMedia } from './microdrama-media';
import type { DramaProject, DramaStore } from './microdrama-store';

export interface DramaDependencies {
  store: DramaStore;
  writer: Pick<BuatSimpelWriter, 'write'>;
  renderer: DramaRenderer;
  media: DramaMedia;
  authorized(owner: number): Promise<boolean>;
  notify(p: DramaProject, text: string): Promise<void>;
  present(p: DramaProject): Promise<void>;
  deliver(p: DramaProject, video: Buffer): Promise<string | undefined>;
}

export function dramaError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'PLAN_INVALID' || error instanceof SyntaxError) return 'Naskah AI tidak memenuhi format dua adegan. Tidak ada render video yang dimulai.';
  if (code === 'LLM_MODEL_UNAVAILABLE') return 'Model naskah sedang tidak tersedia. Pilih model aktif lewat /microdramamodel.';
  if (code.startsWith('LLM_')) return 'Permintaan naskah belum berhasil. Tidak diulang otomatis; permintaan ini mungkin sudah memakai kuota LLM.';
  if (code === 'DEAPI_JOB_FAILED') return 'Provider menyatakan salah satu klip gagal. Tidak ada pengiriman ulang job berbayar.';
  if (code === 'DEAPI_QUOTE_OVER_LIMIT' || code === 'DRAMA_BUDGET_CHANGED') return 'Harga tidak valid, melebihi batas US$0,30 per klip, atau naik dari persetujuan. Submit berikutnya dihentikan.';
  if (code === 'DRAMA_ADMIN_REVOKED') return 'Akses admin tidak lagi aktif. Submit berikutnya dihentikan.';
  if (code === 'DRAMA_APPROVAL_EXPIRED') return 'Estimasi sudah kedaluwarsa. Minta estimasi baru sebelum menyetujui render.';
  if (code === 'DRAMA_MEDIA_INVALID') return 'Klip tidak memiliki ukuran, durasi, atau audio yang diharapkan. Hasil tidak dikirim sebagai video selesai.';
  return 'Proses belum selesai. Status job tersimpan; lanjutkan job yang sama tanpa membuat ulang klip yang sudah diterima.';
}

const cost = (n: number) => `US$${n.toFixed(6)}`;

export class MicrodramaEngine {
  constructor(private d: DramaDependencies) {}

  /** State transitions and all paid requests execute under a cross-process project lock. */
  async act(id: string, owner: number, action: 'write' | 'quote' | 'approve' | 'resume' | 'cancel' | 'revise' | 'recover',
    input?: string): Promise<boolean> {
    return this.d.store.withLock(id, owner, async (p, save) => {
      if (!await this.d.authorized(owner)) throw new Error('DRAMA_ADMIN_REVOKED');
      try {
        if (action === 'cancel') {
          if (['delivered', 'failed', 'cancelled'].includes(p.status)) return;
          p.status = 'cancelled';
          await save();
          await this.d.notify(p, 'Proyek dihentikan. Job yang sudah terkirim tidak dapat dibatalkan di provider; biaya provider yang sudah terpakai tidak dikembalikan oleh fitur uji ini. Saldo bot tidak dipotong.');
        } else if (action === 'recover') {
          if (p.status === 'writing') p.status = p.plan ? 'draft' : 'idea';
          if (p.status === 'quoting') p.status = 'draft';
          await save();
        } else if (action === 'revise') {
          if (!['draft', 'quoted'].includes(p.status)) return;
          p.status = 'revision'; p.quotes = undefined; p.approvedAt = undefined;
          await save();
        } else if (action === 'write') {
          if (!['idea', 'revision'].includes(p.status) || !input || input.length > 1500) return;
          const revision = p.status === 'revision';
          p.status = 'writing'; p.error = undefined;
          if (!revision) p.idea = input;
          await save();
          await this.d.notify(p, 'Menyusun naskah dua adegan. Permintaan ini memakai kuota LLM; belum ada render video.');
          p.plan = await this.d.writer.write(input, p.model, revision ? p.plan : undefined);
          p.status = 'draft'; p.quotes = undefined; p.approvedAt = undefined;
          await save();
        } else if (action === 'quote') {
          if (!p.plan || !['draft', 'quoted'].includes(p.status)) return;
          p.status = 'quoting'; p.error = undefined;
          await save();
          await this.d.media.check();
          // I2V price needs an image. Quote a same-size placeholder; re-quote the actual continuity frame before submit.
          const frame = await this.d.media.placeholder();
          p.quotes = [
            await this.d.renderer.quote(scenePrompt(p.plan, 0)),
            await this.d.renderer.quote(scenePrompt(p.plan, 1), frame),
          ];
          p.status = 'quoted'; p.approvedAt = undefined;
          // Quote timestamp is saved separately from final paid approval.
          p.quotedAt = Date.now();
          await save();
        } else if (action === 'approve') {
          if (!p.plan || p.status !== 'quoted' || !p.quotes || p.quotes.length !== 2) return;
          const quotedAt = p.quotedAt || 0;
          if (Date.now() - quotedAt > 10 * 60_000) {
            p.status = 'draft'; p.quotes = undefined; await save();
            throw new Error('DRAMA_APPROVAL_EXPIRED');
          }
          p.approvedAt = Date.now(); p.status = 'rendering'; p.error = undefined;
          await save();
          await this.render(p, save);
        } else if (action === 'resume') {
          if (!p.approvedAt || !['rendering', 'paused', 'ready'].includes(p.status)) return;
          p.status = 'rendering'; p.error = undefined; await save();
          await this.render(p, save);
        }
      } catch (error) {
        const message = dramaError(error);
        if (action === 'write') p.status = p.plan ? 'draft' : 'idea';
        else if (action === 'quote') p.status = 'draft';
        else if (action === 'approve' || action === 'resume') {
          if (p.jobs.some(j => j.attempted && !j.id)) p.status = 'uncertain';
          else if (p.jobs.some(j => j.failed)) p.status = 'failed';
          else if (p.approvedAt) p.status = 'paused';
        }
        p.error = p.status === 'uncertain'
          ? 'Submit pernah dicoba tetapi ID job belum terkonfirmasi. Jangan render ulang: periksa dashboard provider terlebih dahulu untuk menghindari biaya ganda.'
          : message;
        await save();
        await this.d.notify(p, p.error + '\nSaldo bot tidak dipotong. Biaya provider untuk permintaan yang sudah terkirim mungkin tetap terpakai.');
      }
      await this.d.present(p);
    });
  }

  private async render(p: DramaProject, save: () => Promise<void>) {
    if (!p.plan || !p.quotes || !p.approvedAt) throw new Error('DRAMA_NO_APPROVAL');
    await this.d.media.check();
    const videos: Buffer[] = [];
    for (let n = 0; n < 2; n++) {
      const job = p.jobs[n];
      if (job.failed) throw new Error('DEAPI_JOB_FAILED');
      if (job.attempted && !job.id) throw new Error('DRAMA_SUBMIT_UNCERTAIN');
      if (!job.id) {
        if (!await this.d.authorized(p.owner)) throw new Error('DRAMA_ADMIN_REVOKED');
        const frame = n ? await this.d.media.lastFrame(videos[n - 1]) : undefined;
        const prompt = scenePrompt(p.plan, n);
        const price = await this.d.renderer.quote(prompt, frame);
        if (!Number.isFinite(p.quotes[n]) || price > p.quotes[n] + 0.000001) throw new Error('DRAMA_BUDGET_CHANGED');
        await this.d.notify(p, `Memproses adegan ${n + 1}/2. Estimasi klip ${cost(price)}. Antrean provider dapat memakan puluhan menit.`);
        // Write-ahead marker BEFORE making a paid call. Missing ID after any failure permanently blocks resubmit.
        job.attempted = true; job.price = price; await save();
        job.id = await this.d.renderer.submit(prompt, 71 + n, frame);
        await save();
      }
      if (!job.url) {
        try { job.url = await this.d.renderer.poll(job.id); }
        catch (e) {
          if (e instanceof Error && e.message === 'DEAPI_JOB_FAILED') { job.failed = true; await save(); }
          throw e;
        }
        await save();
      }
      videos.push(await this.d.renderer.download(job.url));
    }
    await this.d.notify(p, 'Kedua klip selesai. Menggabungkan video dan mempertahankan audio asli, tanpa upscale.');
    const video = await this.d.media.assemble(videos);
    p.status = 'ready'; await save();
    p.fileId = await this.d.deliver(p, video);
    p.status = 'delivered'; p.error = undefined;
    await save();
  }
}
