import assert from 'node:assert/strict';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';
import { EpisodeEngine } from '../src/episode-engine';
import { newEpisode } from '../src/episode-types';
import { DeapiRateLimitError } from '../src/deapi-rate-limit';

async function main() {
  for (const kind of ['image', 'video', 'transcript'] as const) {
    const req: EpisodeRequest = { kind, prompt: 'fixture', seed: 71,
      images: kind === 'video' ? [Buffer.from('frame')] : undefined, source: Buffer.from('wav') };
    let disabled = 0;
    const pool = {
      async next(skip: number[] = []) {
        const id = [1, 2].find(id => !skip.includes(id));
        return id ? { id, apiKey: `fixture-${id}` } : null;
      },
      async get(id: number) { return { id, apiKey: `fixture-${id}` }; },
      async disable() { disabled++; return true; },
    };
    const api = new DeapiEpisodeApi(pool, async (_url, init) => {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer fixture-1') {
        return Response.json({ message: 'Rate limit' }, { status: 429, headers: { 'Retry-After': '120' } });
      }
      return Response.json({ data: { price: 0.005, is_estimated: false, request_id: 'accepted-2' } });
    });
    assert.equal((await api.quote(req)).keyId, 2, 'Quote limit rotates without disabling');
    await assert.rejects(api.submit(req, 1), error => error instanceof DeapiRateLimitError);
    assert.equal((await api.quote(req)).keyId, 2, 'Submit cooldown skips original credential');
    assert.equal(disabled, 0);
  }
  for (const refs of [false, true]) {
    for (const mode of ['rate', 'all-rate', 'ambiguous', 'price-increase'] as const) {
      const p: any = { id: 'fixture', owner: 1, episode: newEpisode(1) };
      p.episode.budget = p.episode.refBudget = 1;
      const job: any = {}, saves: any[] = [], submits: number[] = [], results: number[] = [];
      const engine = new EpisodeEngine({
        authorized: async () => true, store: { paused: async () => false },
        api: {
          async quote(_req: EpisodeRequest, skip: number[] = []) {
            const keyId = [1, 2].find(id => !skip.includes(id));
            if (!keyId) throw new Error('DEAPI_POOL_NO_USABLE_KEY');
            return { keyId, price: mode === 'price-increase' && keyId === 2 ? 0.02 : 0.01 };
          },
          async submit(_req: EpisodeRequest, keyId: number) {
            submits.push(keyId);
            assert.equal(saves.at(-1).job.keyId, keyId, 'Persist binding before network submit');
            if (mode === 'ambiguous') throw new Error('socket timed out');
            if (keyId === 1 || mode === 'all-rate') throw new DeapiRateLimitError('SUBMIT', Date.now() + 60_000);
            return 'accepted-2';
          },
          async result(_id: string, keyId: number) { results.push(keyId); return Buffer.from('result'); },
        },
      } as any);
      const request: EpisodeRequest = { kind: 'image', prompt: 'fixture', seed: 71 };
      const run = () => (engine as any).paid(p, async () => {
        saves.push(JSON.parse(JSON.stringify({ job, episode: p.episode })));
      }, job, request, 0.01, refs);
      if (mode === 'rate') {
        assert.equal((await run()).toString(), 'result');
        assert.deepEqual(submits, [1, 2]);
        assert.equal(job.keyId, 2);
        assert.equal(refs ? p.episode.refSpent : p.episode.spent, 0.01, 'Rejected attempts cost no budget');
        await run();
        assert.deepEqual(submits, [1, 2], 'Accepted jobs are not resubmitted');
        assert.deepEqual(results, [2, 2]);
      } else {
        await assert.rejects(run());
        if (mode === 'ambiguous') {
          assert.equal(job.attempted, true);
          assert.equal(refs ? p.episode.refSpent : p.episode.spent, 0.01, 'Ambiguous reservation stays');
          await assert.rejects(run(), /UNCERTAIN/);
          assert.deepEqual(submits, [1]);
        } else {
          assert.equal(job.attempted, false);
          assert.equal(refs ? p.episode.refSpent : p.episode.spent, 0);
          assert.deepEqual(submits, mode === 'all-rate' ? [1, 2] : [1], 'Respect pool exhaustion and approved price');
        }
      }
    }
  }
  console.log('PASS episode rate rotation: images/video/transcription, retained keys, budget release, price caps and no accepted/ambiguous replays.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
