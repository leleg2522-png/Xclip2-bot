import type { Pool } from 'pg';

export const OCTOBER_PROMO = {
  id: 'october_2026_single_topup_200k_promo', // Preserve the original activation, despite the lower threshold.
  enabled: true, // No automatic expiry; stop only on the owner's instruction.
  minimumTopup: 50000,
  price: 1500,
} as const;

const models = new Set(['kling_v21_pro', 'heygen', 'pixverse_v6', 'minimax_h3', 'seedance_2_mini']);
export type OctoberPromoStatus = { active: boolean; eligible: boolean };

// Activation is stored once in the bot's own DB; a restart never moves it.
export async function activateOctoberPromo(db: Pick<Pool, 'query'>): Promise<void> {
  if (!OCTOBER_PROMO.enabled) return;
  await db.query(
    `INSERT INTO bot_migrations (name)
     VALUES ($1) ON CONFLICT (name) DO NOTHING`,
    [OCTOBER_PROMO.id]
  );
}

export async function octoberPromoStatus(
  db: Pick<Pool, 'query'>, dbUserId: number, now = new Date()
): Promise<OctoberPromoStatus> {
  if (!OCTOBER_PROMO.enabled) return { active: false, eligible: false };
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM topup_orders t
       WHERE t.db_user_id = $1 AND t.status = 'PAID' AND t.amount >= $2
         AND t.created_at >= m.applied_at AND t.paid_at >= m.applied_at
         AND t.paid_at <= $3::timestamptz
     ) AS eligible
     FROM bot_migrations m
     WHERE m.name = $4 AND m.applied_at <= $3::timestamptz`,
    [dbUserId, OCTOBER_PROMO.minimumTopup, now.toISOString(), OCTOBER_PROMO.id]
  );
  return { active: result.rows.length > 0, eligible: result.rows[0]?.eligible === true };
}

export function octoberPromoPrice(model: string, normal: number, status: OctoberPromoStatus): number {
  return status.active && status.eligible && models.has(model) ? OCTOBER_PROMO.price : normal;
}

export function octoberPromoText(status: OctoberPromoStatus): string {
  if (!status.active) return '';
  return '\n\n*Promo top-up Rp50.000*\n' +
    'Satu transaksi top-up minimal Rp50.000 yang dibuat dan dibayar sejak promo aktif membuka harga *Rp1.500/video* untuk ' +
    'Kling 2.1 Pro, Heygen, PixVerse v6, MiniMax H3, dan Seedance 2 Mini (image-to-video).\n' +
    'Berlaku *sampai ada pengumuman penghentian*, tanpa tanggal kedaluwarsa otomatis. Top-up lama, akumulasi transaksi, bonus/refund, Uncensored dan Video Edit tidak termasuk.\n' +
    (status.eligible ? '*Status: harga promo aktif di akun kamu.*' : 'Status: belum memenuhi syarat; harga normal tetap berlaku.');
}
