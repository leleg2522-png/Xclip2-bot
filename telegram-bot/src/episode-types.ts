import type { DramaJob, DramaProject } from './microdrama-store';

export const EPISODE_MINUTES_MIN = 1;
export const EPISODE_MINUTES_MAX = 100;
export const STORY_BEATS_PER_MINUTE = 2;
export const SHOTS_PER_BEAT = 3;
export const SHOTS_PER_MINUTE = STORY_BEATS_PER_MINUTE * SHOTS_PER_BEAT;
export const STORY_BEAT_BATCH_SIZE = 10;

export interface StoryAct {
  number: number; startBeat: number; endBeat: number; purpose: string; turningPoint: string;
}
export interface StoryArc {
  prologue: string; centralConflict: string; acts: StoryAct[]; climax: string; epilogue: string;
  endingType: 'closed' | 'open';
}
export interface StoryBeat { objective: string; location: string; cast: string[] }

export function storyActCount(minutes: number) {
  return Math.min(5, Math.max(2, Math.ceil(minutes / 3)));
}
export function storyActRanges(minutes: number) {
  const count = storyActCount(minutes), beats = minutes * STORY_BEATS_PER_MINUTE;
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    startBeat: Math.floor(i * beats / count) + 1,
    endBeat: Math.floor((i + 1) * beats / count),
  }));
}

export type EpisodePhase = 'idea' | 'bible' | 'refs_quote' | 'refs' | 'refs_review' | 'planning'
  | 'script' | 'production_quote' | 'production' | 'quality_hold' | 'clip_review' | 'complete';
export interface CastMember { id: string; name: string; age: number; look: string; voice: string; personality: string }
export interface Location { id: string; description: string }
export interface Bible {
  title: string; synopsis: string; style: string;
  cast: CastMember[]; locations: Location[];
  /** Optional at runtime for projects created before complete-story arcs were stored. */
  arc?: StoryArc;
  beats: StoryBeat[];
}
export interface Dialogue { speaker: string; text: string; subtitleId?: string }
export interface Shot {
  number: number; scene: number; cast: string[]; location: string;
  camera: string; action: string; startState: string; endState: string;
  imagePrompt: string; videoPrompt: string; dialogue: Dialogue[]; continuation: boolean;
  // Optional only for already-persisted projects; new director output requires it.
  negativePrompt?: string;
}
export interface MediaJob extends DramaJob { asset?: string }
export interface TranscriptSegment { start: number; end: number; text: string }
export interface Quality { pass: boolean; issues: string[]; repair: string; overridden?: boolean }
export interface Take {
  image: MediaJob; video: MediaJob; transcriptJob: MediaJob;
  transcript?: TranscriptSegment[]; quality?: Quality; storyQuality?: Quality; repair?: string;
}
export interface ShotWork { shot: Shot; takes: Take[]; accepted?: number; regenerationUsed?: boolean }
export interface Episode {
  version: 1; minutes: number; priceRupiah: number; phase: EpisodePhase; idea?: string; bible?: Bible;
  refs: Record<string, MediaJob>; refsLocked?: boolean; shots: ShotWork[];
  refQuote?: number; refBudget?: number; refSpent: number;
  quote?: { image: number; video: number; transcript: number; total: number };
  quotedAt?: number; budget?: number; spent: number; retakes: number;
  llmCalls: number; busy?: string; reviewNote?: string;
  refHistory?: MediaJob[];
}
export type EpisodeProject = DramaProject & { episode: Episode };
export function episodeProject(p: DramaProject): EpisodeProject {
  if (!p.episode) throw new Error('EPISODE_LEGACY');
  return p as EpisodeProject;
}
export function newEpisode(minutes: number): Episode {
  if (!Number.isInteger(minutes) || minutes < EPISODE_MINUTES_MIN || minutes > EPISODE_MINUTES_MAX) throw new Error('EPISODE_DURATION');
  return { version: 1, minutes, priceRupiah: minutes * 2000, phase: 'idea', refs: {}, shots: [],
    refSpent: 0, spent: 0, retakes: 0, llmCalls: 0 };
}
export function referenceNames(bible: Bible) {
  return [...bible.cast.map(c => `char_${c.id}`), ...bible.locations.map(l => `loc_${l.id}`)];
}
export function selectedRefs(p: EpisodeProject, s: Shot) {
  return [...s.cast.map(id => `char_${id}`), `loc_${s.location}`];
}
