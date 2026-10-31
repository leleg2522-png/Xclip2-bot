import type { DramaJob, DramaProject } from './microdrama-store';

export type EpisodePhase = 'idea' | 'bible' | 'refs_quote' | 'refs' | 'refs_review' | 'planning'
  | 'script' | 'production_quote' | 'production' | 'quality_hold' | 'clip_review' | 'complete';
export interface CastMember { id: string; name: string; age: number; look: string; voice: string; personality: string }
export interface Location { id: string; description: string }
export interface Bible {
  title: string; synopsis: string; style: string;
  cast: CastMember[]; locations: Location[];
  beats: Array<{ objective: string; location: string; cast: string[] }>;
}
export interface Dialogue { speaker: string; text: string }
export interface Shot {
  number: number; scene: number; cast: string[]; location: string;
  camera: string; action: string; startState: string; endState: string;
  imagePrompt: string; videoPrompt: string; dialogue: Dialogue[]; continuation: boolean;
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
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 20) throw new Error('EPISODE_DURATION');
  return { version: 1, minutes, priceRupiah: minutes * 2000, phase: 'idea', refs: {}, shots: [],
    refSpent: 0, spent: 0, retakes: 0, llmCalls: 0 };
}
export function referenceNames(bible: Bible) {
  return [...bible.cast.map(c => `char_${c.id}`), ...bible.locations.map(l => `loc_${l.id}`)];
}
export function selectedRefs(p: EpisodeProject, s: Shot) {
  return [...s.cast.map(id => `char_${id}`), `loc_${s.location}`];
}
