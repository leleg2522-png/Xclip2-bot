import axios from 'axios';

// KlikQRIS — gateway QRIS Indonesia. Mode polling (tanpa webhook): kita create
// order lalu cek status sendiri berkala sampai PAID / expired.
//   Create : POST https://klikqris.com/api/qris/create   (callback_url dikosongkan)
//   Status : GET  https://klikqris.com/api/qris/status/{order_id}
// Semua request pakai header x-api-key + id_merchant dari secret.

const KLIKQRIS_BASE = 'https://klikqris.com/api';
const API_KEY = process.env.KLIKQRIS_API_KEY;
const MERCHANT_ID = process.env.KLIKQRIS_MERCHANT_ID;

export function klikqrisConfigured(): boolean {
  return !!API_KEY && !!MERCHANT_ID;
}

const http = axios.create({ timeout: 30_000 });

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY ?? '',
    'id_merchant': MERCHANT_ID ?? '',
  };
}

// Amount dari KlikQRIS datang sebagai string "1000.00" — bulatkan ke integer Rupiah.
function parseAmount(v: any): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}

// qris_image datang sebagai data URL "data:image/png;base64,....." — ambil base64-nya saja.
function stripDataUrl(s?: string): string | undefined {
  if (!s) return undefined;
  const marker = 'base64,';
  const i = s.indexOf(marker);
  return i >= 0 ? s.slice(i + marker.length) : s;
}

export interface QrisOrder {
  orderId: string;
  amount: number;         // nominal bulat (yang dikreditkan ke saldo)
  totalAmount: number;    // yang harus dibayar user (nominal + kode unik)
  status: string;         // PENDING | SUCCESS | ...
  qrisImageBase64?: string;
  qrisUrl?: string;
  directUrl?: string;
  expiredAt?: string;
  expiredMinutes?: number;
}

export async function createQris(
  orderId: string,
  amount: number,
  keterangan: string
): Promise<QrisOrder> {
  const res = await http.post(
    `${KLIKQRIS_BASE}/qris/create`,
    {
      order_id: orderId,
      id_merchant: MERCHANT_ID,
      amount,
      keterangan,
      callback_url: '',
    },
    { headers: headers() }
  );
  const d = res.data?.data ?? {};
  return {
    orderId: d.order_id ?? orderId,
    amount: parseAmount(d.amount ?? amount),
    totalAmount: parseAmount(d.total_amount ?? amount),
    status: String(d.status ?? 'PENDING').toUpperCase(),
    qrisImageBase64: stripDataUrl(d.qris_image),
    qrisUrl: d.qris_url,
    directUrl: d.direct_url,
    expiredAt: d.expired_at,
    expiredMinutes: d.expired_menit != null ? Number(d.expired_menit) : undefined,
  };
}

export interface QrisStatus {
  orderId: string;
  amount: number;
  totalAmount: number;
  status: string;
  paidAt?: string | null;
}

export async function checkQrisStatus(orderId: string): Promise<QrisStatus> {
  const res = await http.get(
    `${KLIKQRIS_BASE}/qris/status/${encodeURIComponent(orderId)}`,
    { headers: headers() }
  );
  const d = res.data?.data ?? {};
  return {
    orderId: d.order_id ?? orderId,
    amount: parseAmount(d.amount),
    totalAmount: parseAmount(d.total_amount),
    status: String(d.status ?? 'PENDING').toUpperCase(),
    paidAt: d.paid_at ?? null,
  };
}

export function isPaidStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s === 'SUCCESS' || s === 'PAID' || s === 'SETTLED';
}

export function isExpiredStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s === 'EXPIRED' || s === 'FAILED' || s === 'CANCELLED' || s === 'CANCELED';
}
