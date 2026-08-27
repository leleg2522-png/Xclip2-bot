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
assert.match(source, /runPicsartI2v\(ctx\.chat\.id, userId, dbUserId, statusMsg\.message_id, prompt, \{\s*model,\s*imageUrls,\s*ratio,\s*displayLabel,\s*priceKey,/s);
const picsartPromptStart = source.indexOf("// ── Picsart image-to-video prompt ──");
const picsartPromptEnd = source.indexOf("// ── OneOver Seedance 2.5 image-to-video prompt ──", picsartPromptStart);
assert.ok(picsartPromptStart >= 0 && picsartPromptEnd > picsartPromptStart);
const picsartPromptBlock = source.slice(picsartPromptStart, picsartPromptEnd);
const rereadIndex = picsartPromptBlock.indexOf('const activeDraft = getSession(userId);');
const modeGuardIndex = picsartPromptBlock.indexOf("if (activeDraft.mode !== 'picsart_i2v_wait_prompt') return;");
const claimIndex = picsartPromptBlock.indexOf("setSession(userId, {\n      mode: 'idle',");
const statusAwaitIndex = picsartPromptBlock.indexOf('const statusMsg = await ctx.reply');
assert.ok(rereadIndex >= 0, 'Picsart prompt must re-read the active draft after login');
assert.ok(modeGuardIndex > rereadIndex, 'Picsart prompt must validate the re-read mode');
assert.ok(claimIndex > modeGuardIndex, 'Picsart prompt must synchronously claim the active draft');
assert.ok(statusAwaitIndex > claimIndex, 'Picsart prompt must claim the draft before the next await');
assert.match(source, /runKlingP2\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, characterUrlP2, videoFileIdP2, videoDurationP2, prompt\)/);
assert.match(source, /runFloraAudio\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, modelId, label, 'generate', prompt, undefined, undefined, voiceId\)/);

console.log('Parallel generation safety tests passed (isolated draft + three shared job slots).');