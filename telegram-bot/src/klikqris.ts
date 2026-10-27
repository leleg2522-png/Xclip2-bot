import axios from 'axios';

// MY PG uses the merchant's own QRIS. Polling avoids accepting unverified webhooks.
// Public contract: https://www.klikqris.com/dokumentasi-api (MY PG tab).
const BASE = 'https://klikqris.com/api';
const MYPG_PREFIX = 'XCLIP-MYPG-';
type Transport = Pick<ReturnType<typeof axios.create>, 'post' | 'get'>;

export function createTopupOrderId(telegramId: number, timestamp = Date.now()): string {
  return `${MYPG_PREFIX}${telegramId}-${timestamp}`;
}

export function isMyPgOrder(orderId: string): boolean {
  return orderId.startsWith(MYPG_PREFIX);
}

function parseAmount(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new Error('KLIKQRIS_INVALID_AMOUNT');
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('KLIKQRIS_INVALID_AMOUNT');
  return amount;
}

function paymentUrl(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('KLIKQRIS_INVALID_PAYMENT_URL');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
  } catch { throw new Error('KLIKQRIS_INVALID_PAYMENT_URL'); }
  return value;
}

function stripDataUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
}

/** Naive gateway timestamps are in WIB, not the Railway server's timezone. */
export function parseQrisExpiry(value?: string): Date | null {
  if (!value) return null;
  const normalized = value.trim().replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(normalized) ? normalized : `${normalized}+07:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export interface QrisOrder {
  orderId: string;
  amount: number;
  totalAmount: number;
  status: string;
  qrisImageBase64?: string;
  qrisUrl?: string;
  directUrl?: string;
  expiredAt?: string;
  expiredMinutes?: number;
}

export interface QrisStatus {
  orderId: string;
  amount?: number; // MY PG status responses may omit the requested amount.
  totalAmount: number;
  status: string;
  paidAt?: string | null;
}

export function createKlikqrisClient(config: {
  apiKey?: string;
  merchantId?: string;
  http?: Transport;
}) {
  const http = config.http ?? axios.create({ timeout: 30_000 });
  function headers() {
    if (!config.apiKey || !config.merchantId) throw new Error('KLIKQRIS_NOT_CONFIGURED');
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      id_merchant: config.merchantId,
    };
  }
  function data(response: any, orderId: string) {
    const payload = response.data;
    if (payload?.status !== true || !payload.data || payload.data.order_id !== orderId) {
      throw new Error('KLIKQRIS_INVALID_RESPONSE');
    }
    if (typeof payload.data.status !== 'string' || !payload.data.status.trim()) {
      throw new Error('KLIKQRIS_MISSING_STATUS');
    }
    return payload.data;
  }
  return {
    configured: () => !!config.apiKey && !!config.merchantId,
    async createQris(orderId: string, amount: number, keterangan: string): Promise<QrisOrder> {
      if (!isMyPgOrder(orderId)) throw new Error('KLIKQRIS_NEW_ORDER_REQUIRES_MYPG');
      parseAmount(amount);
      // No automatic retries or fallback creates: a timeout may hide an accepted invoice.
      const response = await http.post(`${BASE}/qrisv2/create`, {
        order_id: orderId, id_merchant: config.merchantId, amount, keterangan,
      }, { headers: headers() });
      const d = data(response, orderId);
      const requested = parseAmount(d.amount);
      const total = parseAmount(d.total_amount);
      if (requested !== amount || total < amount) throw new Error('KLIKQRIS_AMOUNT_MISMATCH');
      const qrisUrl = paymentUrl(d.qris_url);
      const directUrl = paymentUrl(d.direct_url);
      const qrisImageBase64 = stripDataUrl(d.qris_image);
      if (!qrisUrl && !directUrl && !qrisImageBase64) throw new Error('KLIKQRIS_MISSING_PAYMENT_DETAILS');
      return {
        orderId, amount, totalAmount: total, status: d.status.toUpperCase(),
        qrisUrl, directUrl, qrisImageBase64, expiredAt: d.expired_at,
        expiredMinutes: d.expired_menit != null ? Number(d.expired_menit) : undefined,
      };
    },
    async checkQrisStatus(orderId: string): Promise<QrisStatus> {
      const auth = headers();
      const path = isMyPgOrder(orderId)
        ? `/qrisv2/status/${encodeURIComponent(config.merchantId!)}/${encodeURIComponent(orderId)}`
        : `/qris/status/${encodeURIComponent(orderId)}`;
      const response = await http.get(`${BASE}${path}`, { headers: auth });
      const d = data(response, orderId);
      return {
        orderId, status: d.status.toUpperCase(), totalAmount: parseAmount(d.total_amount),
        amount: d.amount == null ? undefined : parseAmount(d.amount), paidAt: d.paid_at ?? null,
      };
    },
  };
}

const client = createKlikqrisClient({
  apiKey: process.env.KLIKQRIS_API_KEY,
  merchantId: process.env.KLIKQRIS_MERCHANT_ID,
});
export const klikqrisConfigured = client.configured;
export const createQris = client.createQris;
export const checkQrisStatus = client.checkQrisStatus;

export function isPaidStatus(status: string): boolean {
  return ['SUCCESS', 'PAID', 'SETTLED'].includes(status.toUpperCase());
}

export function isExpiredStatus(status: string): boolean {
  return ['EXPIRED', 'FAILED', 'CANCELLED', 'CANCELED'].includes(status.toUpperCase());
}
