// Fetch fight-night recap inputs from completed UFC events. Phase 107e.
//
// Detects which events are "newsworthy" (any completed fight, since
// every UFC card has at least a main event), packages each event's
// fight card into the FightNightFightLine shape the template
// consumes. The generator runs each detection through the YouTube
// highlight finder for a winner/method-keyed search and persists.

import { fetchUfcScoreboard, type UfcEvent } from '../mma/espn.js';
import type { FightNightFightLine } from './templates.js';

export type FightNightInput = {
  event: UfcEvent;
  fights: FightNightFightLine[];
};

export async function fetchUfcFightNightInputs(opts?: { date?: string }): Promise<FightNightInput[]> {
  // Default range: past 7 days. We re-run on a daily cron so events
  // that completed late don't slip through.
  const events = await safeScoreboard();
  const completed = events.filter((e) => e.state === 'post' && e.fights.some((f) => f.state === 'post'));
  if (opts?.date) {
    // When the cron is run with an explicit date, narrow to events
    // on that ET date so retroactive triggers don't republish older
    // cards (slug upserts make this idempotent regardless, but we
    // skip the work when we can).
    return completed
      .filter((e) => e.date.slice(0, 10) === opts.date)
      .map(packageEvent);
  }
  return completed.map(packageEvent);
}

async function safeScoreboard(): Promise<UfcEvent[]> {
  try {
    return await fetchUfcScoreboard();
  } catch (err) {
    console.warn('fight-night: scoreboard fetch failed', (err as Error).message);
    return [];
  }
}

function packageEvent(event: UfcEvent): FightNightInput {
  const fights: FightNightFightLine[] = event.fights.map((f) => {
    const red = f.fighters.red;
    const blue = f.fighters.blue;
    const winnerId = f.result?.winnerId ?? null;
    const winnerName =
      winnerId === red?.id ? red?.displayName ?? null
      : winnerId === blue?.id ? blue?.displayName ?? null
      : null;
    const loserName =
      winnerId === red?.id ? blue?.displayName ?? null
      : winnerId === blue?.id ? red?.displayName ?? null
      : null;
    return {
      fightId: f.id,
      red: {
        id: red?.id ?? '',
        name: red?.displayName ?? 'TBD',
        record: red?.record ?? null,
        headshot: red?.headshot ?? null,
      },
      blue: {
        id: blue?.id ?? '',
        name: blue?.displayName ?? 'TBD',
        record: blue?.record ?? null,
        headshot: blue?.headshot ?? null,
      },
      winnerId,
      winnerName,
      loserName,
      method: f.result?.method ?? null,
      round: f.result?.round ?? null,
      time: f.result?.time ?? null,
      weightClass: f.weightClass,
      isMain: f.isMain,
      isTitle: f.isTitle,
    };
  });
  return { event, fights };
}
