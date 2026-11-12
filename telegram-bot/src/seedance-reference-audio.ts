import { randomUUID } from 'node:crypto';
import { inspectSeedance25Media } from './seedance25-media';
import { SEEDANCE25_MAX_MEDIA_BYTES, seedance25ReferenceName, type Seedance25Media } from './seedance25-picsart';

export const SEEDANCE2_MAX_AUDIOS = 3;
// Docs permit 15.2s per audio. Keep an aggregate 15s limit for the bot.
export const SEEDANCE2_AUDIO_SECONDS = 15;
export const SEEDANCE2_AUDIO_HELP =
  'Kirim audio MP3/M4A/WAV/OGG atau voice note. Maksimal 3 audio, total 15 detik dan 19MB per file. ' +
  'Audio opsional dan harus disertai gambar atau video. Setelah diterima, lanjutkan referensi atau kirim prompt.';
export type SeedanceAudioBuffer = { buffer: Buffer; name?: string; mime?: string; duration: number };
export type SeedanceAudioDraft = { id: string; refs: Seedance25Media[]; pending: string[] };
export function seedanceAudioMime(file: { mime_type?: string; file_name?: string }): string {
  if (file.mime_type?.startsWith('audio/')) return file.mime_type;
  const extension = file.file_name?.split('.').pop()?.toLowerCase() ?? '';
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' } as Record<string, string>)[extension] ?? 'audio/mpeg';
}
type AudioSession = { mode: string; picsartI2vModel?: string; seedanceAudioDraft?: SeedanceAudioDraft };

export function supportsSeedance2Audio(session: AudioSession): boolean {
  return ['flora_seedance_2_480_wait_image', 'flora_seedance_2_480_wait_prompt'].includes(session.mode)
    || (['picsart_i2v_wait_image', 'picsart_i2v_wait_prompt'].includes(session.mode)
    && ['seedance_2', 'seedance_2_fast', 'seedance_2_mini'].includes(session.picsartI2vModel ?? ''))
    || /^seedance_(?:mini|fast|2)_edit_wait_(?:image|prompt)$/.test(session.mode);
}

export function seedanceAudioContent(urls: string[] = []) {
  if (urls.length > SEEDANCE2_MAX_AUDIOS || urls.some(url => {
    try { const value = new URL(url); return value.protocol !== 'https:' || !!value.username || !!value.password; }
    catch { return true; }
  })) throw Error('SEEDANCE2_AUDIO_INVALID');
  return urls.map(url => ({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' }));
}

export function validateSeedanceAudioBuffers(audios: SeedanceAudioBuffer[] = []) {
  if (audios.length > SEEDANCE2_MAX_AUDIOS
    || audios.some(audio => !audio.buffer.length || audio.buffer.length > SEEDANCE25_MAX_MEDIA_BYTES
      || !Number.isFinite(audio.duration) || audio.duration <= 0 || audio.duration > SEEDANCE2_AUDIO_SECONDS)
    || audios.reduce((total, audio) => total + audio.duration, 0) > SEEDANCE2_AUDIO_SECONDS) {
    throw Error('SEEDANCE2_AUDIO_INVALID');
  }
}

export async function loadSeedanceReferenceAudios(
  refs: Seedance25Media[], download: (fileId: string) => Promise<Buffer>,
): Promise<SeedanceAudioBuffer[]> {
  if (refs.length > SEEDANCE2_MAX_AUDIOS) throw Error('SEEDANCE2_AUDIO_INVALID');
  const audios: SeedanceAudioBuffer[] = [];
  for (const ref of refs) {
    const buffer = await download(ref.fileId);
    const duration = await inspectSeedance25Media(buffer, 'audio');
    audios.push({ buffer, duration, mime: ref.mime, name: seedance25ReferenceName('audio', ref.mime) });
    validateSeedanceAudioBuffers(audios);
  }
  return audios;
}

export function createSeedanceAudioHandler(deps: {
  getSession(userId: number): AudioSession;
  setSession(userId: number, patch: { seedanceAudioDraft?: SeedanceAudioDraft }): void;
  download(fileId: string): Promise<Buffer>;
  inspect?: typeof inspectSeedance25Media;
}) {
  return async (ctx: any, file: { file_id: string; file_size?: number; mime_type?: string; file_name?: string }) => {
    const userId = ctx.from.id, session = deps.getSession(userId);
    if (!supportsSeedance2Audio(session)) return;
    if (file.file_size && file.file_size > SEEDANCE25_MAX_MEDIA_BYTES) return ctx.reply('Audio maksimal 19MB per file.');
    const draft = session.seedanceAudioDraft ?? { id: randomUUID(), refs: [], pending: [] };
    if (draft.pending.includes(file.file_id) || draft.refs.some(ref => ref.fileId === file.file_id)) return ctx.reply('Audio ini sudah diterima atau sedang diperiksa.');
    if (draft.refs.length + draft.pending.length >= SEEDANCE2_MAX_AUDIOS) return ctx.reply('Maksimal 3 audio referensi.');
    deps.setSession(userId, { seedanceAudioDraft: { ...draft, pending: [...draft.pending, file.file_id] } });
    try {
      const buffer = await deps.download(file.file_id);
      if (!buffer.length || buffer.length > SEEDANCE25_MAX_MEDIA_BYTES) throw Error('INVALID_SIZE');
      const duration = await (deps.inspect ?? inspectSeedance25Media)(buffer, 'audio');
      const current = deps.getSession(userId), state = current.seedanceAudioDraft;
      if (!supportsSeedance2Audio(current) || state?.id !== draft.id) return;
      if (duration <= 0 || !Number.isFinite(duration)
        || state.refs.reduce((sum, ref) => sum + ref.duration, 0) + duration > SEEDANCE2_AUDIO_SECONDS) {
        return ctx.reply('Total audio referensi maksimal 15 detik. Potong audio lalu kirim ulang.');
      }
      const mime = seedanceAudioMime(file);
      deps.setSession(userId, { seedanceAudioDraft: { ...state, refs: [...state.refs, { fileId: file.file_id, mime, duration }] } });
      return ctx.reply(`Audio referensi ke-${state.refs.length + 1} diterima (${duration.toFixed(1)} detik).\nAudio berikutnya opsional. Lanjutkan gambar/video atau kirim prompt setelah semua referensi siap.`);
    } catch {
      const current = deps.getSession(userId);
      if (supportsSeedance2Audio(current) && current.seedanceAudioDraft?.id === draft.id) {
        return ctx.reply('Audio tidak bisa dibaca. Gunakan MP3/M4A/WAV/OGG atau voice note, maksimal 19MB dan total 15 detik.');
      }
    } finally {
      const current = deps.getSession(userId), state = current.seedanceAudioDraft;
      if (state?.id === draft.id) deps.setSession(userId, {
        seedanceAudioDraft: { ...state, pending: state.pending.filter(id => id !== file.file_id) },
      });
    }
  };
}
