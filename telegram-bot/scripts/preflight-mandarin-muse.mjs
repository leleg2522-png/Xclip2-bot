/** Non-billable SnapGen account/credit check for one six-scene MUSE episode. */
const key = process.env.SNAPGEN_API_KEY;
if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
if (!key) throw Error('SNAPGEN_KEY_MISSING');

const response = await fetch('https://api.snapgen.ai/uapi/v1/account', {
  headers: { 'x-api-key': key, Accept: 'application/json' },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw Error(`MUSE_ACCOUNT_HTTP_${response.status}`);
const account = await response.json();
const requiredCredits = 6;
if (!account.is_active || account.plan_id !== 'PP0001') throw Error('MUSE_PREMIUM_REQUIRED');
if (Number(account.user_credit?.available_credit) < requiredCredits) {
  throw Error('MUSE_INSUFFICIENT_CREDIT_FOR_EPISODE');
}
console.log(JSON.stringify({ status: 'ready', model: 'muse-ai-video', scenes: 6,
  durationSeconds: 10, orientation: 'portrait', requiredCredits, mediaSubmissions: 0 }));
