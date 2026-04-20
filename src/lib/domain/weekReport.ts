/**
 * Sunday Vibe Report — pure client-side aggregation over decrypted events.
 *
 * The server can't compute this (it sees only ciphertext), so the client
 * reduces the last 7 days of decrypted records into a stats bundle that a
 * celebratory UI renders over. This module is deliberately React-free and
 * Supabase-free so the same reducer could later power a native widget, a
 * scheduled push notification, or a PDF export.
 *
 * Room-kind handling:
 *   - 'pair'  → copy can address "you & your partner"
 *   - 'group' → copy aggregates across everyone ("the crew")
 *   The utility exposes metrics usable either way; the UI picks the voice.
 */

import type { RoomEventRecord } from '@/components/RoomProvider';
import type { LoveLanguage } from './events';
import { LOVE_LANGUAGES } from './events';

export interface WeekReport {
  weekStart: string; // ISO date (UTC-ish, start of the 7-day window)
  weekEnd: string; // ISO date (now, or the explicit anchor)
  roomKind: 'pair' | 'group';
  memberCount: number;
  eventCount: number;

  /** Average of the "social battery" slider across the week, or null if the
   *  room has no slider named that (case-insensitive match on the define
   *  event's title). */
  avgSocialBattery: number | null;

  /** Day with the highest average slider value across every live slider
   *  for every member. ISO date string (YYYY-MM-DD) + avg 0-100. */
  highestVibeDay: { date: string; avg: number } | null;

  /** Per-sender count of distinct calendar days they logged a tank level of 100. */
  daysAtFullTank: Record<string, number>;
  /** Average of every published love_tank_set.level across the week, or null. */
  avgTankLevel: number | null;

  totalHeartsSent: number;
  heartsSentByMember: Record<string, number>;
  heartsReceivedByMember: Record<string, number>;
  /** Sender who gave the most hearts this week. Ties broken by first seen. */
  mostGenerousUserId: string | null;

  safeSpacePosts: number;
  safeSpaceResolutions: number;

  datesCompleted: number;
  /** date_idea_vote events grouped by idea, counting those that crossed the
   *  vote threshold (all current members voted) during the week. */
  newMatches: number;

  messageCount: number;
  reactionsGiven: number;
  mindReaderSolves: number;

  /** Most commonly requested love-language across all love_tank_set events
   *  this week. `null` when no needs were logged. */
  mostRequestedNeed: { need: LoveLanguage; occurrences: number } | null;
}

/** 7 days in ms. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function generateWeekReport(params: {
  events: RoomEventRecord[];
  memberIds: string[];
  roomKind: 'pair' | 'group';
  /** Anchor for the 7-day window. Defaults to now. */
  now?: Date;
}): WeekReport {
  const now = params.now ?? new Date();
  const windowEnd = now.getTime();
  const windowStart = windowEnd - WEEK_MS;

  const members = new Set(params.memberIds);
  const memberCount = params.memberIds.length;

  // Filter once, skipping temp (optimistic) records and anything out of window.
  const recent = params.events.filter((rec) => {
    if (rec.id.startsWith('temp-')) return false;
    const ts = Date.parse(rec.createdAt);
    if (Number.isNaN(ts)) return false;
    return ts >= windowStart && ts <= windowEnd;
  });

  // -- slider stats --------------------------------------------------------
  // Find the slider titled "Social Battery" (case-insensitive). We scan the
  // full stream (not just this week) because defines may have happened
  // earlier. Latest define per sliderId wins.
  const sliderTitles: Record<string, string> = {};
  for (const rec of params.events) {
    if (rec.event.type === 'slider_define') {
      sliderTitles[rec.event.sliderId] = rec.event.title;
    }
  }
  const socialBatterySliderIds = new Set(
    Object.entries(sliderTitles)
      .filter(([, title]) => /social\s*battery/i.test(title))
      .map(([id]) => id),
  );

  let socialBatterySum = 0;
  let socialBatteryCount = 0;

  // For highest-vibe day: bucket slider_set values by YYYY-MM-DD.
  const perDaySliderTotals = new Map<string, { sum: number; n: number }>();

  for (const rec of recent) {
    if (rec.event.type !== 'slider_set') continue;
    if (!members.has(rec.senderId)) continue;
    const day = rec.createdAt.slice(0, 10);
    const bucket = perDaySliderTotals.get(day) ?? { sum: 0, n: 0 };
    bucket.sum += rec.event.value;
    bucket.n += 1;
    perDaySliderTotals.set(day, bucket);
    if (socialBatterySliderIds.has(rec.event.sliderId)) {
      socialBatterySum += rec.event.value;
      socialBatteryCount += 1;
    }
  }

  const avgSocialBattery =
    socialBatteryCount > 0
      ? Math.round(socialBatterySum / socialBatteryCount)
      : null;

  let highestVibeDay: WeekReport['highestVibeDay'] = null;
  for (const [date, { sum, n }] of perDaySliderTotals) {
    if (n === 0) continue;
    const avg = Math.round(sum / n);
    if (!highestVibeDay || avg > highestVibeDay.avg) {
      highestVibeDay = { date, avg };
    }
  }

  // -- love tank -----------------------------------------------------------
  const daysAtFullTank: Record<string, number> = {};
  // Track (sender, day) → level so we only count the latest per day.
  const perSenderDayLevel = new Map<string, number>();
  let tankSum = 0;
  let tankCount = 0;
  const needCounter: Partial<Record<LoveLanguage, number>> = {};

  for (const rec of recent) {
    if (rec.event.type !== 'love_tank_set') continue;
    if (!members.has(rec.senderId)) continue;
    const day = rec.createdAt.slice(0, 10);
    perSenderDayLevel.set(`${rec.senderId}|${day}`, rec.event.level);
    tankSum += rec.event.level;
    tankCount += 1;
    const needs = (rec.event.needs ?? {}) as Partial<
      Record<LoveLanguage, number>
    >;
    let topValue = 0;
    let top: LoveLanguage | null = null;
    for (const k of LOVE_LANGUAGES) {
      const v = needs[k] ?? 0;
      if (v > topValue) {
        topValue = v;
        top = k;
      }
    }
    if (top) needCounter[top] = (needCounter[top] ?? 0) + 1;
  }
  for (const [key, level] of perSenderDayLevel) {
    if (level !== 100) continue;
    const [senderId] = key.split('|');
    daysAtFullTank[senderId] = (daysAtFullTank[senderId] ?? 0) + 1;
  }
  const avgTankLevel =
    tankCount > 0 ? Math.round(tankSum / tankCount) : null;

  let mostRequestedNeed: WeekReport['mostRequestedNeed'] = null;
  for (const need of LOVE_LANGUAGES) {
    const n = needCounter[need] ?? 0;
    if (n <= 0) continue;
    if (!mostRequestedNeed || n > mostRequestedNeed.occurrences) {
      mostRequestedNeed = { need, occurrences: n };
    }
  }

  // -- gratitude -----------------------------------------------------------
  let totalHeartsSent = 0;
  const heartsSentByMember: Record<string, number> = {};
  const heartsReceivedByMember: Record<string, number> = {};
  for (const rec of recent) {
    if (rec.event.type !== 'gratitude_send') continue;
    if (!members.has(rec.senderId)) continue;
    const amount = rec.event.amount;
    totalHeartsSent += amount;
    heartsSentByMember[rec.senderId] =
      (heartsSentByMember[rec.senderId] ?? 0) + amount;
    heartsReceivedByMember[rec.event.to] =
      (heartsReceivedByMember[rec.event.to] ?? 0) + amount;
  }
  let mostGenerousUserId: string | null = null;
  for (const [uid, amt] of Object.entries(heartsSentByMember)) {
    if (
      !mostGenerousUserId ||
      amt > (heartsSentByMember[mostGenerousUserId] ?? 0)
    ) {
      mostGenerousUserId = uid;
    }
  }

  // -- safe space ----------------------------------------------------------
  let safeSpacePosts = 0;
  let safeSpaceResolutions = 0;
  const resolutionsPerEntry: Record<string, Set<string>> = {};
  for (const rec of recent) {
    if (rec.event.type === 'icebreaker_post') {
      if (members.has(rec.senderId)) safeSpacePosts += 1;
    } else if (rec.event.type === 'icebreaker_resolve') {
      if (!members.has(rec.senderId)) continue;
      const set =
        resolutionsPerEntry[rec.event.entryId] ??
        (resolutionsPerEntry[rec.event.entryId] = new Set<string>());
      set.add(rec.senderId);
    }
  }
  // An entry counts as a "resolution" when every current member resolved it.
  for (const set of Object.values(resolutionsPerEntry)) {
    if (set.size >= memberCount && memberCount > 0) safeSpaceResolutions += 1;
  }

  // -- dates ---------------------------------------------------------------
  let datesCompleted = 0;
  const votesPerIdea: Record<string, Set<string>> = {};
  for (const rec of recent) {
    if (rec.event.type === 'date_idea_complete') {
      if (members.has(rec.senderId)) datesCompleted += 1;
    } else if (rec.event.type === 'date_idea_vote') {
      if (!members.has(rec.senderId)) continue;
      const set =
        votesPerIdea[rec.event.ideaId] ??
        (votesPerIdea[rec.event.ideaId] = new Set<string>());
      set.add(rec.senderId);
    }
  }
  let newMatches = 0;
  for (const set of Object.values(votesPerIdea)) {
    if (set.size >= memberCount && memberCount > 0) newMatches += 1;
  }

  // -- engagement ----------------------------------------------------------
  let messageCount = 0;
  let reactionsGiven = 0;
  let mindReaderSolves = 0;
  for (const rec of recent) {
    if (!members.has(rec.senderId)) continue;
    if (rec.event.type === 'message') messageCount += 1;
    else if (rec.event.type === 'add_reaction') reactionsGiven += 1;
    else if (rec.event.type === 'mind_reader_solve') mindReaderSolves += 1;
  }

  return {
    weekStart: new Date(windowStart).toISOString(),
    weekEnd: new Date(windowEnd).toISOString(),
    roomKind: params.roomKind,
    memberCount,
    eventCount: recent.length,
    avgSocialBattery,
    highestVibeDay,
    daysAtFullTank,
    avgTankLevel,
    totalHeartsSent,
    heartsSentByMember,
    heartsReceivedByMember,
    mostGenerousUserId,
    safeSpacePosts,
    safeSpaceResolutions,
    datesCompleted,
    newMatches,
    messageCount,
    reactionsGiven,
    mindReaderSolves,
    mostRequestedNeed,
  };
}

/** Friendly YYYY-MM-DD → "Tuesday, Apr 15" */
export function formatReportDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
