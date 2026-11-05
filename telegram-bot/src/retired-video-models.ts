import type { Context, MiddlewareFn } from 'telegraf';

export function isRetiredVideoCallback(callback: string): boolean {
  return ['mode_pi2v_wan_v2', 'mode_china_wan3', 'mode_china_seedance2',
    'mode_china_happyhorse11', 'menu_video_family_happyhorse'].includes(callback);
}

interface VideoDraft {
  mode: string;
  picsartI2vModel?: string;
  chinaVideoModel?: string;
}

/** Stop new orders and stale drafts, not jobs already accepted by a provider. */
export function retiredVideoModelsGuard(deps: {
  session: (userId: number) => VideoDraft;
  reset: (userId: number) => void;
}): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const callback = ctx.callbackQuery && 'data' in ctx.callbackQuery
      ? ctx.callbackQuery.data : undefined;
    const session = deps.session(userId);
    const removedDraft = (session.mode.startsWith('picsart_i2v_wait_') && session.picsartI2vModel === 'wan_v2')
      || (session.mode.startsWith('china_video_wait_') && ['wan3', 'seedance2', 'happyhorse11'].includes(session.chinaVideoModel ?? ''));
    const removedButton = typeof callback === 'string' && isRetiredVideoCallback(callback);
    if (!removedButton && !removedDraft) return next();
    if (removedDraft) deps.reset(userId);
    if (removedButton) {
      await ctx.answerCbQuery().catch(() => {});
    } else if (callback || (ctx.message && 'text' in ctx.message && ctx.message.text.startsWith('/'))) {
      // Clear the old draft but allow navigation and commands to continue.
      return next();
    }
    await ctx.reply('Model ini sudah dihapus. Gunakan /menu untuk memilih model lain.');
  };
}
