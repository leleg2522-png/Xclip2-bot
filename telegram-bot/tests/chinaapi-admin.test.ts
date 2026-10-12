import assert from 'node:assert/strict';
import { registerChinaApiAdmin } from '../src/chinaapi-admin';

async function main() {
  const commands = new Map<string, any>(), actions = new Map<string, any>();
  let middleware: any, onText: any, admin = true, deleted = 0, fallthrough = 0;
  const replies: Array<{ text: string; options: any }> = [];
  const stored = new Set<string>();
  const key1 = 'fake-china-key-one', key2 = 'fake-china-key-two';
  const bot = {
    use(handler: any) { middleware = handler; },
    on(type: string, handler: any) { assert.equal(type, 'text'); onText = handler; },
    command(names: string[], handler: any) { names.forEach(name => commands.set(name, handler)); },
    action(name: string, handler: any) { actions.set(name, handler); },
  };
  const pool = {
    async addKeys(keys: string[]) {
      const before = stored.size;
      keys.forEach(key => stored.add(key));
      return stored.size - before;
    },
    async stats() { return { available: stored.size, busy: 0, dead: 0, used: 1 }; },
    async list() { return [{ id: 1, status: 'used', busy: false }]; },
  };
  registerChinaApiAdmin(bot as any, pool as any, async () => admin);
  const ctx: any = {
    from: { id: 42 }, chat: { type: 'private' }, message: { text: '' },
    reply: async (text: string, options: any) => { replies.push({ text, options }); },
    deleteMessage: async () => { deleted++; },
    answerCbQuery: async () => {},
  };
  async function command(name: string, text = `/${name}`) {
    ctx.message.text = text;
    await middleware(ctx, () => commands.get(name)(ctx));
  }
  async function text(value: string) {
    ctx.message.text = value;
    await middleware(ctx, () => onText(ctx, async () => { fallthrough++; }));
  }
  await command('chinaapi');
  assert.match(replies.at(-1)!.text, /Total key: 1/);
  const buttons = replies.at(-1)!.options.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((button: any) => button.callback_data === 'china_admin_add'));
  assert.ok(buttons.some((button: any) => button.callback_data === 'china_admin_pool'));
  await command('addchinakey'); // no arguments enters the next-message flow
  await text(`${key1},${key2}\n${key1}`);
  assert.equal(stored.size, 2);
  assert.match(replies.at(-1)!.text, /Ditambahkan: 2\nDuplikat: 1/);
  assert.equal(fallthrough, 0, 'Credential text must not become a generation prompt');
  assert.ok(deleted > 0);
  await text(key1);
  assert.match(replies.at(-1)!.text, /Ditambahkan: 0/);
  await command('chinaapipool');
  assert.match(replies.at(-1)!.text, /Total key: 3/);
  assert.match(replies.at(-1)!.text, /Tersedia: 2/);
  assert.match(replies.at(-1)!.text, /Terpakai sekali: 1/);
  assert.ok(!replies.some(reply => reply.text.includes(key1) || reply.text.includes(key2)));
  await text('normal prompt');
  assert.equal(fallthrough, 1, 'Viewing the pool ends credential-entry mode');
  await actions.get('china_admin_add')(ctx);
  await actions.get('china_admin_cancel')(ctx);
  await text('another normal prompt');
  assert.equal(fallthrough, 2);
  await command('addchinaapikey', `/addchinaapikey@demo_bot ${key1}`);
  assert.match(replies.at(-1)!.text, /Duplikat: 1/);
  ctx.chat.type = 'group';
  await command('addchinakey', '/addchinakey another-fake-key');
  assert.equal(stored.size, 2);
  assert.match(replies.at(-1)!.text, /chat pribadi/);
  ctx.chat.type = 'private';
  admin = false;
  const previousReplies = replies.length;
  await command('chinaapi');
  await command('addchinakey', '/addchinakey another-fake-key');
  assert.equal(replies.length, previousReplies);
  assert.equal(stored.size, 2);
  console.log('ChinaAPI admin menu, batch entry, aliases, counts, cancellation, redaction and access guards passed (offline).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
