import { TextDecoder } from 'node:util';

export const KLING4_PRO_MAX_TXT_BYTES = 26000 * 4 + 3;
export const KLING4_PRO_PROMPT_HELP =
  'Kirim prompt sebagai pesan teks atau file .txt UTF-8. Batas bot: 26.000 karakter ASCII, atau 11.000 karakter jika ada non-ASCII. Isi prompt tidak dipotong.';

// Conservative script-based gate, not an English-language detector. This is
// shared by Telegram intake and the provider builder so neither bypasses limits.
export function validateKling4ProPrompt(text: string): string {
  const prompt = text.trim();
  if (!prompt) throw Error('Prompt kosong. Kirim teks atau file .txt berisi deskripsi video.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    throw Error('Prompt mengandung data biner atau karakter kontrol. Simpan sebagai teks biasa UTF-8.');
  }
  const limit = /[^\x00-\x7f]/.test(prompt) ? 11000 : 26000;
  if (prompt.length > limit) {
    throw Error(`Prompt maksimal ${limit.toLocaleString('id-ID')} karakter untuk jenis teks ini. Isi file tidak dipotong; pendekkan prompt lalu kirim ulang.`);
  }
  return prompt;
}

export function validateKling4ProTxtDocument(file: { file_name?: string; file_size?: number }): void {
  if (!file.file_name || !/\.txt$/i.test(file.file_name)) {
    throw Error('Pada langkah prompt Kling 4 Pro, kirim pesan teks atau file .txt UTF-8.');
  }
  if (file.file_size !== undefined && (!Number.isSafeInteger(file.file_size)
    || file.file_size < 0 || file.file_size > KLING4_PRO_MAX_TXT_BYTES)) {
    throw Error('File .txt terlalu besar atau ukurannya tidak valid. Isi file tidak dipotong.');
  }
}

export function decodeKling4ProTxt(buffer: Buffer): string {
  if (buffer.length > KLING4_PRO_MAX_TXT_BYTES) throw Error('File .txt terlalu besar. Isi file tidak dipotong.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw Error('Encoding file tidak valid. Simpan file .txt sebagai UTF-8 lalu kirim ulang.');
  }
  return validateKling4ProPrompt(text);
}
