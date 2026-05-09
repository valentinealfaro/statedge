// UFC / MMA stat-key registry — Phase 110a.
//
// Canonical vocabulary for fight props. Every PrizePicks variant
// gets normalized to one of these keys at the parser boundary.
// Display labels live alongside so the frontend doesn't reinvent
// them.

export type UfcStatKey =
  | 'sig_strikes'           // total significant strikes landed
  | 'rd1_sig_strikes'       // round-1 significant strikes
  | 'takedowns'             // takedowns landed
  | 'rd1_takedowns'         // round-1 takedowns
  | 'knockdowns'            // knockdowns scored
  | 'rounds'                // rounds the fight reaches (1.5 = goes past R1)
  | 'fight_time'            // fight length in minutes (14.99 ≈ full 15min fight)
  | 'fantasy_score'         // PrizePicks UFC fantasy formula
  | 'control_time';         // ground-control time in minutes

export type UfcStatMeta = {
  key: UfcStatKey;
  label: string;            // "Significant Strikes"
  shortLabel: string;       // "Sig Strikes"
  unit: string;             // "strikes" / "min" / "td" / "score"
  // Categorization for the slate UI: "in-fight stats" vs "fight length"
  // are mentally distinct and should group separately.
  group: 'volume' | 'duration' | 'fantasy';
};

const META: Record<UfcStatKey, UfcStatMeta> = {
  sig_strikes:      { key: 'sig_strikes',      label: 'Significant Strikes',          shortLabel: 'Sig Strikes',     unit: 'strikes', group: 'volume' },
  rd1_sig_strikes:  { key: 'rd1_sig_strikes',  label: 'Round 1 Significant Strikes',  shortLabel: 'R1 Sig Strikes',  unit: 'strikes', group: 'volume' },
  takedowns:        { key: 'takedowns',        label: 'Takedowns',                    shortLabel: 'Takedowns',       unit: 'td',      group: 'volume' },
  rd1_takedowns:    { key: 'rd1_takedowns',    label: 'Round 1 Takedowns',            shortLabel: 'R1 Takedowns',    unit: 'td',      group: 'volume' },
  knockdowns:       { key: 'knockdowns',       label: 'Knockdowns',                   shortLabel: 'Knockdowns',      unit: 'kd',      group: 'volume' },
  rounds:           { key: 'rounds',           label: 'Rounds',                       shortLabel: 'Rounds',          unit: 'rd',      group: 'duration' },
  fight_time:       { key: 'fight_time',       label: 'Fight Time',                   shortLabel: 'Fight Time',      unit: 'min',     group: 'duration' },
  fantasy_score:    { key: 'fantasy_score',    label: 'Fantasy Score',                shortLabel: 'Fantasy',         unit: 'score',   group: 'fantasy' },
  control_time:     { key: 'control_time',     label: 'Control Time',                 shortLabel: 'Control',         unit: 'min',     group: 'volume' },
};

export function ufcStatMeta(key: UfcStatKey): UfcStatMeta {
  return META[key];
}

export function listUfcStats(): UfcStatMeta[] {
  return Object.values(META);
}
