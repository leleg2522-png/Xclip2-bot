import type { Context, MiddlewareFn } from 'telegraf';

const retiredCallback = /^(?:mode_seedance_(?:mini|fast|2)_edit$|seedance_(?:edit_|fast_edit_|2_edit_))/;
const retiredMode = /^seedance_(?:mini|fast|2)_edit_wait_(?:ratio|video|image|prompt)$/;

/**
 * Keep old Telegram buttons and unfinished drafts from starting a retired paid
 * model. Already accepted background jobs are not cancelled by this guard.
 */
export function retiredSeedanceVideoEditGuard(deps: {
  mode: (userId: number) => string;
  reset: (userId: number) => void;
}): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const callback = ctx.callbackQuery && 'data' in ctx.callbackQuery
      ? ctx.callbackQuery.data : undefined;
    const removedButton = typeof callback === 'string' && retiredCallback.test(callback);
    const removedDraft = retiredMode.test(deps.mode(userId));
    if (!removedButton && !removedDraft) return next();

    if (removedDraft) deps.reset(userId);
    if (removedButton) {
      await ctx.answerCbQuery().catch(() => {});
    } else if (callback || (ctx.message && 'text' in ctx.message && ctx.message.text.startsWith('/'))) {
      // Let navigation and commands proceed normally after clearing an old draft.
      return next();
    }
    await ctx.reply('Seedance Video Edit sudah dihapus. Gunakan /menu untuk memilih model lain.');
  };
}
