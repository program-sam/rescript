import { getCutRanges, isWordCutOut } from "./edits";
import { copyOf, copyRange, ofCopy, sourceOrder } from "./sequence";
import type { CopyRange, ManualCut, SourceCopy, TimeRange, Word } from "./types";

/** How long "Shorten silences" leaves each silence by default (seconds). */
export const DEFAULT_SILENCE_LENGTH = 0.3;

/** Range (seconds) of the "Shorten silences to" slider. */
export const SILENCE_LENGTH_RANGE = { min: 0.1, max: 3, step: 0.1 } as const;

/**
 * Default share of a shortened silence kept after the previous word (0.2s of
 * 0.3s); the rest stays before the next word. Speech sounds tighter with less
 * air before a word.
 */
export const DEFAULT_SILENCE_SPLIT = 2 / 3;

/**
 * Trims shorter than this (seconds) are inaudible and would only add cuts to
 * the export, so silences within this much of the target length stay as they are.
 */
export const MIN_SILENCE_TRIM = 0.05;

const SILENCE_LENGTH_STORAGE_KEY = "rescript.silence-length";
const SILENCE_SPLIT_STORAGE_KEY = "rescript.silence-split";

function snap(value: number, range: { min: number; max: number; step: number }): number | null {
  if (!Number.isFinite(value)) return null;
  const snapped = Math.round(value / range.step) * range.step;
  return Number(Math.min(range.max, Math.max(range.min, snapped)).toFixed(1));
}

/** Snap a silence length onto the slider's steps, or null when it is not a number. */
export function normalizeSilenceLength(value: number): number | null {
  return snap(value, SILENCE_LENGTH_RANGE);
}

/** Clamp an after/before split to 0–1, or null when it is not a number. */
export function normalizeSilenceSplit(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

function load(key: string, normalize: (value: number) => number | null, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? null : normalize(Number(raw));
    if (value !== null) return value;
  } catch {
    /* private mode / blocked storage */
  }
  return fallback;
}

function save(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

export const loadSilenceLength = () =>
  load(SILENCE_LENGTH_STORAGE_KEY, normalizeSilenceLength, DEFAULT_SILENCE_LENGTH);
export const saveSilenceLength = (length: number) => save(SILENCE_LENGTH_STORAGE_KEY, length);
export const loadSilenceSplit = () =>
  load(SILENCE_SPLIT_STORAGE_KEY, normalizeSilenceSplit, DEFAULT_SILENCE_SPLIT);
export const saveSilenceSplit = (split: number) => save(SILENCE_SPLIT_STORAGE_KEY, split);

/** Seconds kept after the previous word and before the next one; they add up to `length`. */
export function silenceKeep(length: number, split: number): { after: number; before: number } {
  const after = Math.round(length * split * 100) / 100;
  return { after, before: Math.round((length - after) * 100) / 100 };
}

/**
 * Manual cuts that hold no words at all — what "Shorten silences" leaves behind
 * (and any trim that happened to land on a pause). Restoring these brings the
 * quiet audio back without un-deleting speech, so a cut that merged with a
 * word-bearing cut is deliberately left out.
 */
export function findSilenceCuts(
  words: Word[],
  manualCuts: ManualCut[]
): TimeRange[] {
  return manualCuts
    .filter(
      (c) =>
        c.end - c.start > 1e-4 &&
        !words.some((w) => w.end > c.start + 1e-4 && w.start < c.end - 1e-4)
    )
    .map((c) => ({ start: c.start, end: c.end }));
}

/** Split `range` into the pieces not covered by any of `cuts`. */
function subtractCuts(range: TimeRange, cuts: TimeRange[]): TimeRange[] {
  let parts: TimeRange[] = [range];
  for (const cut of cuts) {
    parts = parts.flatMap((p) => {
      if (cut.end <= p.start + 1e-4 || cut.start >= p.end - 1e-4) return [p];
      const out: TimeRange[] = [];
      if (cut.start > p.start + 1e-4) out.push({ start: p.start, end: cut.start });
      if (cut.end < p.end - 1e-4) out.push({ start: cut.end, end: p.end });
      return out;
    });
  }
  return parts;
}

/**
 * Find the parts of silences to cut so that each silence plays for at most
 * `length` seconds: `after` stays after the previous word and `before` stays
 * before the next one (see `silenceKeep`). Silences before the first word and
 * after the last keep only the side next to speech; media edges are cut flush.
 * Already-cut audio is never reported again, so the result is idempotent.
 */
export function findSilenceRanges(
  words: Word[],
  duration: number,
  manualCuts: ManualCut[] = [],
  length = DEFAULT_SILENCE_LENGTH,
  split = DEFAULT_SILENCE_SPLIT
): TimeRange[] {
  if (duration <= 0) return [];

  const cuts = getCutRanges(words, duration, manualCuts);
  const kept = words
    .filter((w) => !isWordCutOut(w, cuts))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Gaps between kept words, tagged with whether each edge abuts speech.
  type Gap = { start: number; end: number; speechBefore: boolean; speechAfter: boolean };
  const gaps: Gap[] = [];
  let cursor = 0;
  let prevWasSpeech = false;
  for (const w of kept) {
    if (w.start > cursor + 1e-4) {
      gaps.push({
        start: cursor,
        end: w.start,
        speechBefore: prevWasSpeech,
        speechAfter: true,
      });
    }
    cursor = Math.max(cursor, w.end);
    prevWasSpeech = true;
  }
  if (duration > cursor + 1e-4) {
    gaps.push({
      start: cursor,
      end: duration,
      speechBefore: prevWasSpeech,
      speechAfter: false,
    });
  }

  const { after, before } = silenceKeep(length, split);
  const out: TimeRange[] = [];
  for (const gap of gaps) {
    for (const part of subtractCuts({ start: gap.start, end: gap.end }, cuts)) {
      // Keep audio only on edges that still sit against speech (not a prior cut).
      const keepStart = gap.speechBefore && Math.abs(part.start - gap.start) < 1e-4;
      const keepEnd = gap.speechAfter && Math.abs(part.end - gap.end) < 1e-4;
      const start = part.start + (keepStart ? after : 0);
      const end = part.end - (keepEnd ? before : 0);
      if (end - start >= MIN_SILENCE_TRIM - 1e-4) out.push({ start, end });
    }
  }
  return out;
}

/**
 * findSilenceRanges for every copy of the media: the original over the whole
 * file, each pasted duplicate within its own range. Each range names its copy.
 */
export function findCopySilenceRanges(
  words: Word[],
  duration: number,
  manualCuts: ManualCut[],
  copies: SourceCopy[],
  length = DEFAULT_SILENCE_LENGTH,
  split = DEFAULT_SILENCE_SPLIT
): CopyRange[] {
  const out: CopyRange[] = [];
  const order = sourceOrder(words);
  if (!order.has(0)) order.set(0, []);
  for (const [copy, list] of order) {
    const copyWords = list.map((i) => words[i]);
    const range = copyRange(copy, copies, duration);
    // A duplicate with every word deleted is cut whole already.
    if (copy !== 0 && copyWords.every((w) => w.deleted)) continue;
    for (const r of findSilenceRanges(copyWords, range.end, ofCopy(manualCuts, copy), length, split)) {
      const start = Math.max(r.start, range.start);
      if (r.end - start < MIN_SILENCE_TRIM - 1e-4) continue;
      out.push(copy === 0 ? { ...r, copy } : { start, end: r.end, copy });
    }
  }
  return out;
}

/** findSilenceCuts for every copy, each range naming its copy. */
export function findCopySilenceCuts(words: Word[], manualCuts: ManualCut[]): CopyRange[] {
  const out: CopyRange[] = [];
  for (const copy of new Set(manualCuts.map(copyOf))) {
    const copyWords = words.filter((w) => copyOf(w) === copy);
    for (const r of findSilenceCuts(copyWords, ofCopy(manualCuts, copy))) {
      out.push({ ...r, copy });
    }
  }
  return out;
}
