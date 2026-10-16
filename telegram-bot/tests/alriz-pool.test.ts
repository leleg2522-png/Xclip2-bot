import assert from 'node:assert/strict';
import { AlrizKeyPool } from '../src/alriz-key-pool';
import { generateKlingAlrizFromPool, type AlrizMotionApi } from '../src/alriz-motion';
import { registerAlrizAdmin } from '../src/alriz-admin';

const input = { image: Buffer.from('photo'), video: Buffer.from('motion'), prompt: 'move', seconds: 10 };
async function rotationTests() {
  for (const outcome of ['success', 'rejected-auth', 'rejected-credit', 'submit-timeout', 'no-id', 'poll-auth', 'poll-failed', 'empty']) {
    const events = { posts: 0, next: [] as number[][], dead: [] as number[], keys: [] as string[] };
    const api: Omit<AlrizMotionApi, 'apiKey'> & { pool: any } = {
      pool: {
        next: async (skip: number[]) => {
          events.next.push([...skip]);
          if (outcome === 'empty') return null;
          const id = skip.includes(1) ? 2 : 1;
          return { id, apiKey: `fixture-key-${id}` };
        },
        disable: async (id: number) => { events.dead.push(id); return true; },
      },
      publish: async (_bytes, video) => `https://our-domain.test/${video ? 'video' : 'image'}`,
      status: async () => {}, wait: async () => {}, maxPolls: 1,
      http: {
        post: async (_url, _body, config) => {
          events.posts++;
          events.keys.push(config.headers['X-API-Key']);
          if (outcome === 'rejected-auth' && events.posts === 1) return { status: 401, data: {} };
          if (outcome === 'rejected-credit' && events.posts === 1) return { status: 402, data: {} };
          if (outcome === 'submit-timeout') throw Error('timeout');
          return { status: 202, data: outcome === 'no-id' ? {} : { job_id: 'accepted' } };
        },
        get: async () => {
          if (outcome === 'poll-auth') return { status: 401, data: {} };
          return { status: 200, data: {
            status: outcome === 'poll-failed' ? 'FAILED' : 'DONE', result_url: 'https://cdn.test/result.mp4',
          } };
        },
      },
    };
    if (['success', 'rejected-auth', 'rejected-credit'].includes(outcome)) {
      assert.equal(await generateKlingAlrizFromPool(input, api), 'https://cdn.test/result.mp4');
    } else {
      await assert.rejects(generateKlingAlrizFromPool(input, api));
    }
    const rotate = ['rejected-auth', 'rejected-credit'].includes(outcome);
    assert.equal(events.posts, outcome === 'empty' ? 0 : rotate ? 2 : 1, 'Only explicit pre-acceptance rejections allow failover');
    assert.deepEqual(events.dead, rotate || outcome === 'poll-auth' ? [1] : []);
    assert.deepEqual(events.next, rotate ? [[], [1]] : [[]]);
    if (rotate) assert.deepEqual(events.keys, ['fixture-key-1', 'fixture-key-2']);
  }
}

async function databaseTests() {
  const calls: Array<{ sql: string; params: any[] | undefined }> = [];
  const pool = new AlrizKeyPool({
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('INSERT')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.includes('RETURNING id, api_key')) return { rows: [{ id: 1, api_key: 'fixture-private-key' }], rowCount: 1 };
      if (sql.includes('COUNT(*)')) return { rows: [{ available: 1, dead: 0 }], rowCount: 1 };
      return { rows: [{ id: 1, status: 'available' }], rowCount: 1 };
    },
  });
  await pool.ensureSchema();
  assert.equal(await pool.addKeys([' fixture-private-key ', 'fixture-private-key']), 1);
  assert.deepEqual(calls.at(-1)?.params, [['fixture-private-key']]);
  assert.doesNotMatch(calls.at(-1)!.sql, /fixture-private-key/);
  assert.deepEqual(await pool.next([2]), { id: 1, apiKey: 'fixture-private-key' });
  assert.match(calls.at(-1)!.sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls.at(-1)?.params, [[2]]);
  assert.equal(await pool.disable(1), true);
  assert.equal(await pool.restore(1), true);
  assert.deepEqual(await pool.stats(), { available: 1, dead: 0 });
  assert.deepEqual(await pool.list(), [{ id: 1, status: 'available' }]);
  assert.doesNotMatch(calls.at(-1)!.sql, /api_key/);
  await assert.rejects(pool.addKeys(['invalid key']), /INVALID_KEY_FORMAT/);
  const broken = new AlrizKeyPool({ query: async () => { throw Error('private key in DB error'); } });
  await assert.rejects(broken.next(), error => String(error) === 'Error: ALRIZ_POOL_DATABASE_FAILED');
}

async function adminTests() {
  const commands: Record<string, (ctx: any) => Promise<any>> = {};
  const events = { added: [] as string[][], disable: [] as number[], restore: [] as number[] };
  const pool = {
    addKeys: async (keys: string[]) => { events.added.push(keys); return keys.length; },
    stats: async () => ({ available: 1, dead: 0 }),
    list: async () => [{ id: 4, status: 'available' }],
    disable: async (id: number) => { events.disable.push(id); return true; },
    restore: async (id: number) => { events.restore.push(id); return true; },
  };
  let authorized = true;
  registerAlrizAdmin({ command: (name: string, handler: any) => { commands[name] = handler; } } as any,
    pool as any, async () => authorized);
  const messages: string[] = [];
  let deletes = 0;
  const ctx: any = {
    chat: { type: 'private' }, message: { text: '/addalrizkey fixture-private-key' },
    reply: async (text: string) => { messages.push(text); },
    deleteMessage: async () => { deletes++; },
  };
  authorized = false;
  await commands.addalrizkey(ctx);
  assert.equal(events.added.length, 0);
  authorized = true;
  ctx.chat.type = 'group';
  await commands.addalrizkey(ctx);
  assert.equal(events.added.length, 0);
  ctx.chat.type = 'private';
  await commands.addalrizkey(ctx);
  assert.deepEqual(events.added, [['fixture-private-key']]);
  assert.equal(deletes, 3);
  await commands.alrizpool(ctx);
  assert.doesNotMatch(messages.join(' '), /fixture-private-key/);
  assert.match(messages.join(' '), /ID 4: available/);
  ctx.message.text = '/nonaktifalrizkey 4'; await commands.nonaktifalrizkey(ctx);
  ctx.message.text = '/restorealrizkey 4'; await commands.restorealrizkey(ctx);
  ctx.message.text = '/nonaktifalrizkey 4;DROP'; await commands.nonaktifalrizkey(ctx);
  assert.deepEqual(events.disable, [4]);
  assert.deepEqual(events.restore, [4]);
}

async function main() {
  await rotationTests(); await databaseTests(); await adminTests();
  console.log('Alriz database pool: parameterized storage, safe rotation/no paid replay, private admin access and masked responses passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
