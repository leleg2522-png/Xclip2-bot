import { TextDecoder } from 'node:util';
import { SEEDANCE25_MAX_PROMPT_CHARS } from './seedance25-picsart';

// Bound the download before decoding. Enough for the UTF-8 representation of
// every allowed prompt, including an optional BOM, without accepting large files.
export const SEEDANCE25_MAX_TXT_BYTES = SEEDANCE25_MAX_PROMPT_CHARS * 4 + 3;

export function validateSeedance25Prompt(text: string): string {
  const prompt = text.trim();
  if (!prompt) throw Error('Prompt kosong. Kirim teks atau file .txt berisi deskripsi video.');
  if (prompt.length > SEEDANCE25_MAX_PROMPT_CHARS) {
    throw Error('Prompt maksimal 20.000 karakter. Isi file tidak dipotong; pendekkan prompt lalu kirim ulang.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    throw Error('Prompt mengandung data biner atau karakter kontrol. Simpan sebagai teks biasa UTF-8.');
  }
  return prompt;
}

export function validateSeedance25TxtDocument(file: { file_name?: string; file_size?: number }): void {
  if (!file.file_name || !/\.txt$/i.test(file.file_name)) {
    throw Error('Pada langkah prompt, kirim pesan teks atau file .txt (UTF-8), bukan file referensi.');
  }
  if (file.file_size !== undefined && file.file_size > SEEDANCE25_MAX_TXT_BYTES) {
    throw Error('File .txt terlalu besar. Maksimal 20.000 karakter; isi file tidak dipotong.');
  }
}

export function decodeSeedance25Txt(buffer: Buffer): string {
  if (buffer.length > SEEDANCE25_MAX_TXT_BYTES) {
    throw Error('File .txt terlalu besar. Maksimal 20.000 karakter; isi file tidak dipotong.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw Error('Encoding file tidak valid. Simpan file .txt sebagai UTF-8 lalu kirim ulang.');
  }
  return validateSeedance25Prompt(text);
}
