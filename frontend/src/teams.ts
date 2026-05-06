// Static lookup: NBA team abbreviation → stats.nba.com team_id.
// Same table the backend's NBA_TEAMS list keys off, exposed on the
// frontend so we can build /compare deep-links from anywhere we
// only know the 3-letter abbr (e.g., the byOpponent table on the
// Last 10 view, ESPN game detail's team mapping).

export const ABBR_TO_NBA_ID: Record<string, number> = {
  ATL: 1610612737, BOS: 1610612738, BKN: 1610612751, CHA: 1610612766,
  CHI: 1610612741, CLE: 1610612739, DAL: 1610612742, DEN: 1610612743,
  DET: 1610612765, GSW: 1610612744, GS:  1610612744, HOU: 1610612745,
  IND: 1610612754, LAC: 1610612746, LAL: 1610612747, MEM: 1610612763,
  MIA: 1610612748, MIL: 1610612749, MIN: 1610612750, NOP: 1610612740,
  NO:  1610612740, NYK: 1610612752, NY:  1610612752, OKC: 1610612760,
  ORL: 1610612753, PHI: 1610612755, PHX: 1610612756, POR: 1610612757,
  SAC: 1610612758, SAS: 1610612759, SA:  1610612759, TOR: 1610612761,
  UTA: 1610612762, WAS: 1610612764,
};

export function teamIdFromAbbr(abbr: string): number | null {
  return ABBR_TO_NBA_ID[abbr.toUpperCase()] ?? null;
}
