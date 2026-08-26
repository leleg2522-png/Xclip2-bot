import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /const MAX_PARALLEL_GENERATIONS_PER_USER = 3/);
assert.match(source, /generationDraft\?: boolean/);
assert.match(source, /generationDraftKind\?: GenerationDraftKind/);
assert.match(source, /const GENERATION_DRAFT_MODES = new Set<Mode>/);
assert.match(source, /function generationDraftKindForStart\(data: string\): GenerationDraftKind \| undefined/);
assert.match(source, /function generationDraftKindForContinuation\(data: string\): GenerationDraftKind \| undefined/);
assert.match(source, /function reserveGenerationDraft\(userId: number, kind: GenerationDraftKind\)/);
assert.match(source, /function isGenerationEntryCallback\(data: string\): boolean/);
assert.match(source, /if \(session\.generationDraft === true \|\| GENERATION_DRAFT_MODES\.has\(session\.mode\)\) return 'draft'/);
assert.match(source, /Synchronous reservation: two rapid callback updates cannot both start a wizard/);
assert.match(source, /const startKind = generationDraftKindForStart\(data\);/);
assert.match(source, /const blocked = reserveGenerationDraft\(userId, startKind\);/);
assert.match(source, /const continuationKind = generationDraftKindForContinuation\(data\);/);
assert.match(source, /session\.generationDraftKind !== continuationKind/);
assert.match(source, /generationCompleted = data\.mode === 'idle'/);
assert.match(source, /bot\.command\('cancel', \(ctx\) => \{\s+setSession\(ctx\.from\.id, \{ mode: 'idle', generationDraft: false, generationDraftKind: undefined \}\);/s);
assert.match(source, /MAX_PARALLEL_GENERATIONS_PER_USER\} proses generate aktif/);

const concurrentCharges = source.match(/beginCharge\(dbUserId, PRICE, 3\)/g) ?? [];
assert.ok(concurrentCharges.length >= 15, 'all generation runners must retain the shared 3-job limit');

// Every job is started with immutable local arguments and retains its own
// captured Telegram status message rather than a shared status slot.
assert.match(source, /runPicsartI2v\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, prompt, \{ model, imageUrl, ratio \}\)/);
assert.match(source, /runKlingP2\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, characterUrlP2, videoFileIdP2, videoDurationP2, prompt\)/);
assert.match(source, /runFloraAudio\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, modelId, label, 'generate', prompt, undefined, undefined, voiceId\)/);

console.log('Parallel generation safety tests passed (isolated draft + three shared job slots).');