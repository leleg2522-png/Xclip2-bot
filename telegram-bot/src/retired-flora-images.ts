import type { Context, MiddlewareFn } from 'telegraf';

/** Retire the entire image catalogue without affecting Flora video/audio jobs. */
export function retiredFloraImagesGuard(deps: {
  mode: (userId: number) => string;
  reset: (userId: number) => void;
}): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const callback = ctx.callbackQuery && 'data' in ctx.callbackQuery
      ? ctx.callbackQuery.data : undefined;
    const removedButton = typeof callback === 'string'
      && (callback === 'menu_flora_image' || callback.startsWith('floraimg_'));
    const removedDraft = deps.mode(userId) === 'floraimg_wait_prompt';
    if (!removedButton && !removedDraft) return next();
    if (removedDraft) deps.reset(userId);
    if (removedButton) {
      await ctx.answerCbQuery().catch(() => {});
    } else if (callback || (ctx.message && 'text' in ctx.message && ctx.message.text.startsWith('/'))) {
      return next();
    }
    await ctx.reply('Katalog AI Image ini sudah dihapus. Gunakan /menu untuk memilih model gambar lainnya.');
  };
}
