import { createHash } from 'node:crypto';
import type { DramaProject, DramaStore } from './microdrama-store';
import { episodeProject, referenceNames, selectedRefs, type EpisodeProject, type MediaJob, type ShotWork, type Take } from './episode-types';
import { lockedPrompt, type Director } from './episode-director';
import type { EpisodeApi, EpisodeRequest } from './episode-api';
import { EpisodeMedia, dialogueIssues, parseTranscript } from './episode-media';

export interface EpisodeStore extends DramaStore {
  putAsset(id: string, name: string, bytes: Buffer): Promise<void>;
  asset(id: string, name: string): Promise<Buffer>;
  requestPause(id: string, owner: number, pause?: boolean): Promise<void>;
  paused(id: string, owner: number): Promise<boolean>;
}
export interface EpisodeDependencies {
  store: EpisodeStore; api: EpisodeApi; director: Director; media: EpisodeMedia;
  authorized(owner: number): Promise<boolean>;
  notify(p: EpisodeProject, text: string): Promise<void>;
  present(p: EpisodeProject): Promise<void>;
  preview(p: EpisodeProject, name: string, bytes: Buffer): Promise<void>;
  inspect?(p: EpisodeProject, shot: number, file: string, note: string): Promise<void>;
  deliver(p: EpisodeProject, files: { video: string; subtitles: string }): Promise<void>;
}
const seed = (p: EpisodeProject, name: string) => createHash('sha256').update(p.id + name).digest().readUInt32BE(0) % 2_000_000_000;
const freshTake = (repair?: string): Take => ({ image: {}, video: {}, transcriptJob: {}, repair });
export type EpisodeAction = 'write' | 'revise' | 'quote_refs' | 'make_refs' | 'redo_ref' | 'lock_refs'
  | 'plan' | 'quote' | 'render' | 'resume' | 'recover' | 'retry' | 'accept' | 'cancel';
export function episodeError(error: unknown) {
  const s = error instanceof Error ? error.message : '';
  if (s === 'EPISODE_PAUSE') return 'Dijeda sesuai permintaan.';
  if (s === 'EPISODE_BUDGET' || s === 'EPISODE_PRICE_INVALID') return 'Harga atau anggaran tidak memenuhi persetujuan. Tidak ada submit berikutnya.';
  if (s === 'EPISODE_UNCERTAIN') return 'Ada submit yang pernah dicoba tanpa ID terkonfirmasi. Periksa dashboard provider; sistem tidak akan mengirim ulang.';
  if (s === 'EPISODE_LLM_BUSY') return 'Permintaan LLM sebelumnya belum terkonfirmasi. Pilih Pulihkan LLM bila proses memang terputus; permintaan baru dapat memakai kuota lagi.';
  if (s === 'DEAPI_POOL_NO_USABLE_KEY') return 'Tidak ada key pool yang dapat memakai model ini. Periksa /deapipool, akses model dan saldo akun provider.';
  if (s === 'EPISODE_QUOTE_EXPIRED') return 'Estimasi kedaluwarsa. Minta estimasi baru sebelum menyetujui.';
  if (s === 'EPISODE_ADMIN') return 'Akses admin sudah tidak aktif; submit berikutnya dihentikan.';
  if (s === 'DIRECTOR_FORMAT' || error instanceof SyntaxError) return 'Output sutradara tidak memenuhi format/aturan kontinuitas. Tidak diulang otomatis.';
  if (s === 'DEAPI_JOB_FAILED') return 'Provider menyatakan job gagal. Tidak ada pengiriman ulang otomatis.';
  return 'Proses terhenti. Progres dan job tersimpan; lanjutkan job yang sama, bukan membuat ulang episode.';
}

export class EpisodeEngine {
  constructor(private d: EpisodeDependencies) {}
  private async guard(p: EpisodeProject) {
    if (!await this.d.authorized(p.owner)) throw new Error('EPISODE_ADMIN');
    if (await this.d.store.paused(p.id, p.owner)) throw new Error('EPISODE_PAUSE');
  }
  private async llm<T>(p: EpisodeProject, save: () => Promise<void>, label: string, call: () => Promise<T>): Promise<T> {
    if (p.episode.busy) throw new Error('EPISODE_LLM_BUSY');
    await this.guard(p);
    p.episode.busy = label; p.episode.llmCalls++; await save();
    // No retry on a failed/ambiguous LLM call. The explicit recover action acknowledges new quota.
    const result = await call();
    p.episode.busy = undefined; await save(); return result;
  }
  async act(id: string, owner: number, action: EpisodeAction, input = '') {
    return this.d.store.withLock(id, owner, async (project: DramaProject, save) => {
      const p = episodeProject(project), e = p.episode;
      if (!await this.d.authorized(owner)) throw new Error('EPISODE_ADMIN');
      if (['cancelled', 'delivered', 'failed'].includes(p.status) && action !== 'cancel') return;
      try {
        if (action === 'cancel') {
          p.status = 'cancelled'; e.busy = undefined; await save();
          await this.d.notify(p, 'Proyek dihentikan. Job upstream dan biaya provider yang sudah terpakai tidak dapat dibatalkan oleh fitur ini.');
        } else if (action === 'recover') {
          e.busy = undefined; p.error = undefined; await save();
        } else if (action === 'write' || action === 'revise') {
          if (!['idea', 'bible', 'refs_quote'].includes(e.phase) || (action === 'revise' && !e.bible) || input.length > 2000) return;
          p.status = 'writing';
          if (action === 'write') e.idea = input;
          await save();
          e.bible = await this.llm(p, save, 'bible', () => this.d.director.bible(input, e.minutes, p.model, action === 'revise' ? e.bible : undefined));
          e.phase = 'bible'; p.status = 'draft'; e.refQuote = undefined; e.refBudget = undefined; await save();
        } else if (action === 'quote_refs') {
          if (!e.bible || !['bible', 'refs_quote'].includes(e.phase)) return;
          await this.d.media.check();
          const q = await this.d.api.quote(this.refRequest(p, referenceNames(e.bible)[0]));
          e.refQuote = q.price; e.quotedAt = Date.now(); e.phase = 'refs_quote'; p.status = 'quoted'; await save();
        } else if (action === 'make_refs' || action === 'redo_ref') {
          if (action === 'make_refs') {
            if (!['refs_quote', 'refs'].includes(e.phase) || !e.refQuote || !e.bible) return;
            if (!e.refBudget) {
              if (Date.now() - (e.quotedAt || 0) > 600_000) throw new Error('EPISODE_QUOTE_EXPIRED');
              e.refBudget = e.refQuote * (referenceNames(e.bible).length + 2);
            }
            e.phase = 'refs'; p.status = 'rendering'; await save();
            for (const name of referenceNames(e.bible)) await this.reference(p, save, name);
          } else {
            if (e.phase !== 'refs_review' || e.refsLocked || !e.bible || !referenceNames(e.bible).includes(input)) return;
            if (!e.refs[input]?.asset) throw new Error('EPISODE_UNCERTAIN');
            if ((e.refHistory?.length || 0) >= 2) throw new Error('EPISODE_BUDGET');
            e.refHistory ||= [];
            e.refHistory.push({ ...e.refs[input] }); e.refs[input] = {};
            e.phase = 'refs'; p.status = 'rendering'; await save();
            await this.reference(p, save, input);
          }
          e.phase = 'refs_review'; p.status = 'draft'; await save();
        } else if (action === 'lock_refs') {
          if (e.phase !== 'refs_review' || !e.bible || referenceNames(e.bible).some(n => !e.refs[n]?.asset)) return;
          e.refsLocked = true; e.phase = 'planning'; p.status = 'writing'; await save();
          await this.plan(p, save);
        } else if (action === 'plan') {
          if (e.phase !== 'planning') return;
          await this.plan(p, save);
        } else if (action === 'quote') {
          if (!['script', 'production_quote'].includes(e.phase) || !e.refsLocked || !e.bible) return;
          const frame = await this.d.media.placeholder(), first = e.shots[0].shot;
          // Quote the worst supported reference count, not just the first beat's cast.
          const names = [...e.bible.cast.map(c => `char_${c.id}`), `loc_${first.location}`];
          const images = await Promise.all(names.map(n => this.d.store.asset(p.id, e.refs[n].asset!)));
          const image = await this.d.api.quote({ kind: 'image', prompt: lockedPrompt(e, first, false), images, seed: 71 });
          const video = await this.d.api.quote({ kind: 'video', prompt: lockedPrompt(e, first, true), images: [frame], seed: 71 });
          const transcript = await this.d.api.quote({ kind: 'transcript', prompt: '', seed: 71 });
          const anchors = e.shots.filter(w => !w.shot.continuation).length;
          e.quote = { image: image.price, video: video.price, transcript: transcript.price,
            total: image.price * anchors + (video.price + transcript.price) * e.shots.length
              + (image.price + video.price + transcript.price) * 2 };
          e.quotedAt = Date.now(); e.phase = 'production_quote'; p.status = 'quoted'; await save();
        } else if (action === 'render' || action === 'resume' || action === 'retry' || action === 'accept') {
          if (action === 'resume' && e.phase === 'refs') {
            for (const name of referenceNames(e.bible!)) await this.reference(p, save, name);
            e.phase = 'refs_review'; p.status = 'draft'; await save();
          } else if (action === 'resume' && e.phase === 'planning') await this.plan(p, save);
          else {
            if (action === 'render') {
              if (e.phase !== 'production_quote' || !e.quote) return;
              if (Date.now() - (e.quotedAt || 0) > 600_000) throw new Error('EPISODE_QUOTE_EXPIRED');
              e.budget = e.quote.total;
            } else if (action === 'retry' || action === 'accept') {
              if (e.phase !== 'quality_hold') return;
              const w = e.shots.find(w => w.accepted === undefined);
              if (!w || Number(input) !== w.shot.number) return;
              const t = w.takes.at(-1)!;
              if (action === 'accept') {
                if (!t.video.id || !t.transcript || !t.quality) return;
                t.quality.overridden = true; w.accepted = w.takes.length - 1;
              } else {
                if (e.retakes >= 2) throw new Error('EPISODE_BUDGET');
                e.retakes++; w.takes.push(freshTake(t.quality?.repair || t.storyQuality?.repair)); await save();
              }
            } else if (!['production', 'quality_hold', 'complete'].includes(e.phase) || e.phase === 'quality_hold') return;
            if (!e.budget || !e.quote) return;
            e.phase = 'production'; p.status = 'rendering'; p.error = undefined; await save();
            await this.produce(p, save);
          }
        }
      } catch (error) {
        const uncertain = [...Object.values(e.refs), ...e.shots.flatMap(w => w.takes.flatMap(t => [t.image, t.video, t.transcriptJob]))]
          .some(j => j.attempted && !j.id && !j.asset);
        p.status = uncertain ? 'uncertain' : 'paused';
        p.error = error instanceof Error && error.message === 'EPISODE_PAUSE'
          ? 'Dijeda sesuai permintaan. Job yang sudah diterima tetap tersimpan; tidak ada submit berikutnya.' : episodeError(error);
        if (error instanceof Error && error.message === 'DEAPI_JOB_FAILED' && e.phase === 'production') {
          const w = e.shots.find(w => w.accepted === undefined);
          const t = w?.takes.at(-1);
          if (t) {
            t.quality = { pass: false, issues: ['Provider menyatakan job gagal. Retake memerlukan keputusan admin.'], repair: t.repair || '' };
            e.phase = 'quality_hold'; e.reviewNote = `Shot ${w!.shot.number}: job provider gagal. Tidak diulang otomatis.`;
          }
        }
        await save(); await this.d.notify(p, p.error);
      }
      await this.d.present(p);
    });
  }
  private refRequest(p: EpisodeProject, name: string): EpisodeRequest {
    const b = p.episode.bible!, c = b.cast.find(c => name === `char_${c.id}`), l = b.locations.find(l => name === `loc_${l.id}`);
    if (!c && !l) throw new Error('EPISODE_REFERENCE');
    return { kind: 'image', seed: seed(p, name), prompt: c
      ? `Photorealistic casting reference, a single adult Indonesian actor, ${c.age}, ${c.look}. Neutral front three-quarter view, waist-up, clearly visible face, realistic skin. ${b.style}. Plain background. No collage, writing or extra people.`
      : `Photorealistic empty film set establishing reference. ${l!.description}. ${b.style}. No people, no writing or collage.` };
  }
  private async paid(p: EpisodeProject, save: () => Promise<void>, job: MediaJob, req: EpisodeRequest, cap: number, refs = false) {
    if (job.failed) throw new Error('DEAPI_JOB_FAILED');
    if (job.attempted && !job.id) throw new Error('EPISODE_UNCERTAIN');
    if (!job.id) {
      await this.guard(p);
      const q = await this.d.api.quote(req), e = p.episode;
      const spent = refs ? e.refSpent : e.spent, budget = refs ? e.refBudget : e.budget;
      if (!budget || q.price > cap + 0.000001 || spent + q.price > budget + 0.000001) throw new Error('EPISODE_BUDGET');
      await this.guard(p);
      job.attempted = true; job.price = q.price; job.keyId = q.keyId;
      if (refs) e.refSpent += q.price; else e.spent += q.price;
      await save(); // Both account identity and conservative spend reservation precede the paid request.
      job.id = await this.d.api.submit(req, q.keyId); await save();
    }
    try { return await this.d.api.result(job.id, job.keyId!); }
    catch (error) {
      if (error instanceof Error && error.message === 'DEAPI_JOB_FAILED') { job.failed = true; await save(); }
      throw error;
    }
  }
  private async reference(p: EpisodeProject, save: () => Promise<void>, name: string) {
    const e = p.episode, job = e.refs[name] ||= {};
    if (!job.asset) {
      const data = await this.paid(p, save, job, this.refRequest(p, name), e.refQuote!, true);
      const asset = `${name}_${e.refHistory?.length || 0}`;
      await this.d.store.putAsset(p.id, asset, await this.d.media.jpeg(data)); job.asset = asset; await save();
    }
    await this.d.preview(p, name, await this.d.store.asset(p.id, job.asset));
  }
  private async plan(p: EpisodeProject, save: () => Promise<void>) {
    const e = p.episode;
    while (e.shots.length < e.minutes * 6) {
      const scene = e.shots.length / 3;
      await this.d.notify(p, `Sutradara menyusun adegan ${scene + 1}/${e.bible!.beats.length}, termasuk kamera, blocking dan kontinuitas.`);
      const shots = await this.llm(p, save, `scene_${scene}`, () => this.d.director.scene(e, scene, p.model));
      e.shots.push(...shots.map(shot => ({ shot, takes: [] }))); await save();
    }
    e.phase = 'script'; p.status = 'draft'; await save();
  }
  private async refs(p: EpisodeProject, shot: ShotWork['shot']) {
    return Promise.all(selectedRefs(p, shot).map(n => this.d.store.asset(p.id, p.episode.refs[n].asset!)));
  }
  private async videoFile(p: EpisodeProject, w: ShotWork, t: Take, i: number) {
    let file = await this.d.media.cache(p.id, w.shot.number, i);
    if (!file) {
      if (!t.video.id || !t.video.keyId) throw new Error('EPISODE_VIDEO_MISSING');
      file = await this.d.media.cache(p.id, w.shot.number, i, await this.d.api.result(t.video.id, t.video.keyId));
    }
    await this.d.media.probe(file!); return file!;
  }
  private async produce(p: EpisodeProject, save: () => Promise<void>) {
    const e = p.episode;
    for (const w of e.shots) {
      if (w.accepted !== undefined) continue;
      while (w.accepted === undefined) {
        await this.guard(p);
        if (!w.takes.length) { w.takes.push(freshTake()); await save(); }
        const i = w.takes.length - 1, t = w.takes[i], refs = await this.refs(p, w.shot);
        await this.d.notify(p, `Shot ${w.shot.number}/${e.shots.length} • take ${i + 1} • penggunaan render US$${e.spent.toFixed(4)}/US$${e.budget!.toFixed(4)}`);
        if (!t.image.asset) {
          let frame: Buffer;
          if (w.shot.continuation && !t.repair) {
            const previous = e.shots[w.shot.number - 2];
            const prior = previous.takes[previous.accepted!];
            frame = await this.d.media.frame(await this.videoFile(p, previous, prior, previous.accepted!), 9.9);
          } else frame = await this.paid(p, save, t.image,
            { kind: 'image', prompt: lockedPrompt(e, w.shot, false, t.repair), images: refs, seed: seed(p, `shot_${w.shot.number}_${i}`) }, e.quote!.image);
          const name = `shot_${w.shot.number}_${i}`;
          await this.d.store.putAsset(p.id, name, await this.d.media.jpeg(frame)); t.image.asset = name; await save();
        }
        const frame = await this.d.store.asset(p.id, t.image.asset);
        if (!t.storyQuality) {
          const images = await Promise.all([...refs, frame].map(b => this.d.media.jpeg(b, true)));
          t.storyQuality = await this.llm(p, save, `story_review_${w.shot.number}_${i}`, () =>
            this.d.director.review(p.model, `Storyboard check. Reference order: ${selectedRefs(p, w.shot).join(', ')}. Last image is candidate.\n${JSON.stringify(w.shot)}`, images));
          await save();
        }
        if (t.storyQuality.pass) {
          if (!t.video.id) {
            const bytes = await this.paid(p, save, t.video, { kind: 'video', prompt: lockedPrompt(e, w.shot, true, t.repair),
              images: [frame], seed: seed(p, `video_${w.shot.number}_${i}`) }, e.quote!.video);
            await this.d.media.cache(p.id, w.shot.number, i, bytes);
          }
          const file = await this.videoFile(p, w, t, i);
          if (!t.transcript) {
            const audio = await this.d.media.audio(file);
            const data = await this.paid(p, save, t.transcriptJob, { kind: 'transcript', prompt: '', source: audio, seed: 71 }, e.quote!.transcript);
            t.transcript = parseTranscript(data); await save();
          }
          if (!t.quality) {
            const frames = await Promise.all([0.5, 4.5, 8.5].map(n => this.d.media.frame(file, n)));
            const images = await Promise.all([...refs, ...frames].map(b => this.d.media.jpeg(b, true)));
            t.quality = await this.llm(p, save, `video_review_${w.shot.number}_${i}`, () =>
              this.d.director.review(p.model, `Video continuity check. Reference order: ${selectedRefs(p, w.shot).join(', ')}; last 3 images are sampled frames.\n${JSON.stringify(w.shot)}`, images));
            const audioIssues = dialogueIssues(w, t.transcript);
            t.quality.issues.push(...audioIssues);
            if (audioIssues.length) { t.quality.pass = false; t.quality.repair += ' Speak exactly the scripted Indonesian lines, one speaker at a time, finish before 8.5 seconds.'; }
            await save();
          }
        } else t.quality = t.storyQuality;
        if (t.quality!.pass) { w.accepted = i; await save(); }
        else if (i === 0 && e.retakes < 2) {
          // Explicitly included in the production approval: at most TWO retakes total, at most one automatic per shot.
          e.retakes++; w.takes.push(freshTake(t.quality!.repair)); await save();
        } else {
          e.phase = 'quality_hold'; p.status = 'paused';
          e.reviewNote = `Shot ${w.shot.number}: ${t.quality!.issues.join('; ')}`; await save();
          if (t.video.id && t.transcript && this.d.inspect) {
            await this.d.inspect(p, w.shot.number, await this.videoFile(p, w, t, i), e.reviewNote);
          } else {
            await this.d.preview(p, `storyboard_shot_${w.shot.number}`, frame);
          }
          return;
        }
      }
    }
    const files = [];
    for (const w of e.shots) files.push(await this.videoFile(p, w, w.takes[w.accepted!], w.accepted!));
    await this.d.notify(p, 'Semua shot diterima. Menggabungkan episode, menormalkan volume dan menambahkan subtitle dari transkripsi.');
    const output = await this.d.media.assemble(p, files);
    e.phase = 'complete'; p.status = 'ready'; await save();
    await this.d.deliver(p, output); p.status = 'delivered'; p.error = undefined; await save();
    await this.d.media.cleanup(p.id).catch(() => {});
  }
}
