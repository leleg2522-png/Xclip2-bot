/**
 * Public generation failures are an allowlist of Indonesian explanations.
 * Never return upstream text, even after redacting known provider names:
 * unknown suppliers, URLs, keys and account details must stay private too.
 */
export interface GenerationErrorContext { stage?: string }
export type GenerationErrorKind = 'sensitive' | 'copyright' | 'size' | 'duration' | 'image'
  | 'video' | 'audio' | 'input' | 'unavailable' | 'busy' | 'timeout' | 'network'
  | 'upload' | 'finishing' | 'delivery' | 'uncertain' | 'unknown';

function errorFacts(error: unknown): string {
  const parts: string[] = [], seen = new Set<unknown>();
  let budget = 200;
  const visit = (value: any, depth: number) => {
    if (--budget < 0 || depth > 7 || value == null || seen.has(value)) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value).slice(0, 4000)); return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    if (Array.isArray(value)) { value.slice(0, 8).forEach(v => visit(v, depth + 1)); return; }
    // Deliberately exclude config, request, headers, prompts, input and URLs.
    for (const key of ['message', 'code', 'reason', 'detail', 'description', 'error_message',
      'error_code', 'failure_reason', 'error', 'errors', 'cause', 'statusCode', 'status', 'data']) {
      try { visit(value[key], depth + 1); } catch { /* hostile getters are not public errors */ }
    }
    try {
      if (value.response) {
        visit(value.response.status, depth + 1);
        visit(value.response.error_code, depth + 1);
        visit(value.response.data, depth + 1);
      }
    } catch { /* malformed transport error */ }
  };
  visit(error, 0);
  return parts.join(' ').toLowerCase()
    .replace(/https?:\/\/\S+|data:[^\s]+/g, ' ')
    .replace(/(?:no|not)\s+(?:sensitive|nsfw|unsafe)\s+content(?:\s+detected)?/g, ' ');
}

export function classifyGenerationError(error: unknown, context: GenerationErrorContext = {}): GenerationErrorKind {
  const raw = errorFacts(error);
  if (context.stage === 'delivery') return 'delivery';
  if (/(?:content|safety)[_ .-]*(?:policy|moderation|filter|violation|blocked|rejected)|prompt[_ .-]*moderat|moderat(?:ed|ion[_ .-]*(?:failed|rejected|blocked))|nsfw|sensitive|unsafe[_ .-]*content|色情|敏感|违规|konten sensitif|kebijakan konten/.test(raw)) return 'sensitive';
  if (/copyright|intellectual.property|hak cipta/.test(raw)) return 'copyright';
  if (/too[_ .-]*large|size[_ .-]*(?:limit|invalid)|media_size_limit|maxcontentlength|(?:^|[\s_:])413(?=$|[\s:;,])|melebihi batas|terlalu besar|maksimal \d+\s?mb/.test(raw)) return 'size';
  if (/(?:duration|length|seconds)[_ .-]*(?:invalid|limit|mismatch|exceed|changed)|reference_duration|durasi.{0,45}(?:harus|maksimal|minimal|detik)/.test(raw)) return 'duration';
  if (/invalid[_ .-]*(?:(?:character|reference)[_ .-]*)?image|image[_ .-]*(?:invalid|unsupported)|unsupported_image_format|invalid_file_content|empty_file|foto.{0,30}(?:harus|minimal|tidak valid)/.test(raw)) return 'image';
  if (/invalid[_ .-]*(?:reference[_ .-]*)?video|video[_ .-]*(?:invalid|unsupported)|wan_reference_invalid|video.{0,30}(?:harus|tidak valid)/.test(raw)) return 'video';
  if (/audio[_ .-]*(?:invalid|unsupported|missing)|invalid[_ .-]*audio/.test(raw)) return 'audio';
  if (/ratio[_ .-]*(?:invalid|mismatch)|invalid[_ .-]*(?:input|ratio|parameter)|unsupported[_ .-]*(?:parameter|resolution)|input[_ .-]*invalid|reference_limit|(?:^|[\s_:])422(?=$|[\s:;,])/.test(raw)) return 'input';
  if (/no[_ .-]*(?:credential|account|session|usable[_ .-]*key)|key[_ .-]*(?:missing|expired|invalid)|unconfigured|unavailable|unauthori[sz]ed|forbidden|insufficient[_ .-]*(?:credit|balance)|quota[_ .-]*(?:exceed|exhaust)|credit.{0,15}(?:exhaust|insufficient)|account[_ .-]*(?:suspend|disable)|auth[_ .-]*(?:fail|lost)|(?:^|[\s_:])(?:401|402|403)(?=$|[\s:;,])/.test(raw)) return 'unavailable';
  if (/high[_ .-]*traffic|rate[_ .-]*limit|too many requests|overload|capacity|(?:^|[\s_:])429(?=$|[\s:;,])|antrean penuh/.test(raw)) return 'busy';
  if (/submit[_ .-]*(?:ambiguous|uncertain|unknown)|unknown[_ .-]*submit|post[_ .-]*submit.{0,30}ambiguous/.test(raw)) return 'uncertain';
  if (/timeout|timed[_ .-]*out|etimedout|econnaborted|deadline|proses terlalu lama/.test(raw)) return 'timeout';
  if (/econnreset|econnrefused|enotfound|eai_again|network|socket|fetch failed|http[_ .-]*5\d\d|(?:^|[\s_:])(?:500|502|503|504)(?=$|[\s:;,])/.test(raw)) return 'network';
  if (/delivery[_ .-]*fail|send[_ .-]*(?:video|photo|document)[_ .-]*fail|hasil.{0,20}gagal.{0,15}kirim/.test(raw) || context.stage === 'delivery') return 'delivery';
  if (/finish[_ .-]*fail|upscale.{0,30}(?:fail|mismatch)|crop.{0,30}(?:fail|mismatch)|output_settings_mismatch|output_ratio_mismatch/.test(raw) || context.stage === 'finishing') return 'finishing';
  if (/upload[_ .-]*fail/.test(raw) || context.stage === 'upload' || context.stage === 'download') return 'upload';
  return 'unknown';
}

const explanations: Record<GenerationErrorKind, string> = {
  sensitive: 'Prompt, media referensi, atau hasil ditolak oleh filter konten sensitif. Ubah bagian yang sensitif atau gunakan referensi lain.',
  copyright: 'Permintaan ditolak karena pembatasan hak cipta. Gunakan materi yang diizinkan atau ubah prompt dan referensinya.',
  size: 'Ukuran file referensi melebihi batas yang diizinkan. Kompres file dan ikuti batas ukuran yang tertera pada model.',
  duration: 'Durasi video atau audio referensi tidak sesuai batas model. Potong file sesuai rentang durasi yang tertera.',
  image: 'Foto referensi tidak valid atau tidak didukung. Periksa format, ukuran, dan resolusinya, lalu kirim foto yang sesuai.',
  video: 'Video referensi tidak valid atau tidak dapat dibaca. Periksa format, durasi, dan resolusinya, lalu kirim video yang sesuai.',
  audio: 'Audio referensi tidak tersedia, tidak valid, atau tidak didukung. Kirim ulang audio dengan format dan durasi yang sesuai.',
  input: 'Referensi atau pengaturan tidak sesuai persyaratan model. Periksa jumlah referensi, rasio, resolusi, dan pilihan durasi.',
  unavailable: 'Layanan model sementara tidak tersedia. Coba lagi nanti atau hubungi admin; tidak perlu mengubah prompt hanya karena pesan ini.',
  busy: 'Layanan sedang ramai atau batas permintaan sedang tercapai. Tunggu beberapa saat sebelum mencoba lagi.',
  timeout: 'Waktu pemrosesan melewati batas tunggu. Hasil belum dapat diselesaikan; coba lagi nanti.',
  network: 'Koneksi ke layanan pemrosesan sedang bermasalah. Coba lagi nanti.',
  upload: 'File referensi gagal diambil atau diunggah. Pastikan file dapat dibuka, lalu kirim ulang referensinya.',
  finishing: 'Hasil belum berhasil disiapkan sesuai kualitas yang diminta. Ini kegagalan pemrosesan hasil; coba lagi nanti.',
  delivery: 'Hasil belum berhasil dikirim atau diambil untuk pengiriman. Periksa koneksi dan pastikan bot tidak diblokir.',
  uncertain: 'Status penerimaan permintaan tidak dapat dipastikan karena gangguan layanan. Proses tidak diulang otomatis untuk menghindari tagihan ganda.',
  unknown: 'Proses gagal, tetapi layanan tidak memberikan penyebab yang jelas. Coba lagi nanti atau hubungi admin.',
};

export function generationErrorMessage(error: unknown, context: GenerationErrorContext = {}): string {
  const kind = classifyGenerationError(error, context);
  if (kind === 'sensitive') {
    const raw = errorFacts(error);
    if (/output[_ .-]*(?:sensitive|nsfw|moderat)|generated[_ .-]*(?:content|image|video).{0,30}(?:sensitive|nsfw|reject)/.test(raw)) {
      return '❌ Hasil yang dibuat ditolak oleh filter konten sensitif. Ubah prompt atau referensi agar hasilnya sesuai ketentuan.';
    }
    if (/(?:image|photo|gambar|foto).{0,25}(?:sensitive|nsfw|unsafe|moderat)|(?:sensitive|nsfw).{0,15}(?:image|photo)/.test(raw)) {
      return '❌ Foto referensi ditolak oleh filter konten sensitif. Gunakan foto lain yang sesuai ketentuan.';
    }
    if (/(?:video).{0,25}(?:sensitive|nsfw|unsafe|moderat)/.test(raw)) {
      return '❌ Video referensi ditolak oleh filter konten sensitif. Gunakan video lain yang sesuai ketentuan.';
    }
    if (/(?:prompt|text).{0,25}(?:sensitive|nsfw|unsafe|moderat)/.test(raw)) {
      return '❌ Prompt ditolak oleh filter konten sensitif. Ubah bagian prompt yang sensitif lalu coba lagi.';
    }
  }
  return `❌ ${explanations[kind]}`;
}

/** Attach diagnostic fields to a fixed internal code without changing retry logic. */
export function generationFailure(code: string, cause: unknown): Error {
  return new Error(code, { cause });
}
