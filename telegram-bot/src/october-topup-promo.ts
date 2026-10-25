import type { Pool } from 'pg';

export const OCTOBER_PROMO = {
  id: 'october_2026_single_topup_200k_promo',
  endsAt: '2026-11-01T00:00:00+07:00',
  minimumTopup: 200000,
  price: 1500,
} as const;

const models = new Set(['kling_v21_pro', 'heygen', 'pixverse_v6', 'minimax_h3', 'seedance_2_mini']);
export type OctoberPromoStatus = { active: boolean; eligible: boolean };

// Activation is stored once in the bot's own DB; a restart never moves it.
export async function activateOctoberPromo(db: Pick<Pool, 'query'>): Promise<void> {
  await db.query(
    `INSERT INTO bot_migrations (name)
     SELECT $1 WHERE NOW() < $2::timestamptz ON CONFLICT (name) DO NOTHING`,
    [OCTOBER_PROMO.id, OCTOBER_PROMO.endsAt]
  );
}

export async function octoberPromoStatus(
  db: Pick<Pool, 'query'>, dbUserId: number, now = new Date()
): Promise<OctoberPromoStatus> {
  if (now.getTime() >= Date.parse(OCTOBER_PROMO.endsAt)) return { active: false, eligible: false };
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM topup_orders t
       WHERE t.db_user_id = $1 AND t.status = 'PAID' AND t.amount >= $2
         AND t.created_at >= m.applied_at AND t.paid_at >= m.applied_at
         AND t.paid_at <= $3::timestamptz AND t.paid_at < $4::timestamptz
     ) AS eligible
     FROM bot_migrations m
     WHERE m.name = $5 AND m.applied_at <= $3::timestamptz`,
    [dbUserId, OCTOBER_PROMO.minimumTopup, now.toISOString(), OCTOBER_PROMO.endsAt, OCTOBER_PROMO.id]
  );
  return { active: result.rows.length > 0, eligible: result.rows[0]?.eligible === true };
}

export function octoberPromoPrice(model: string, normal: number, status: OctoberPromoStatus): number {
  return status.active && status.eligible && models.has(model) ? OCTOBER_PROMO.price : normal;
}

export function octoberPromoText(status: OctoberPromoStatus): string {
  if (!status.active) return '';
  return '\n\n*Promo top-up Rp200.000*\n' +
    'Satu transaksi top-up minimal Rp200.000 yang dibuat dan dibayar sejak promo aktif membuka harga *Rp1.500/video* untuk ' +
    'Kling 2.1 Pro, Heygen, PixVerse v6, MiniMax H3, dan Seedance 2 Mini (image-to-video).\n' +
    'Berlaku sampai *31 Oktober 2026, 23.59 WIB*. Top-up lama, akumulasi transaksi, bonus/refund, Uncensored dan Video Edit tidak termasuk.\n' +
    (status.eligible ? '*Status: harga promo aktif di akun kamu.*' : 'Status: belum memenuhi syarat; harga normal tetap berlaku.');
}
