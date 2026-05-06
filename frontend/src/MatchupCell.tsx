import { TeamLogo } from './Avatar';

type Props = {
  opponentAbbr: string;
  isHome: boolean;
};

// Render the matchup column as a small opponent logo + home/away marker
// + abbreviation. Replaces raw "LAL vs. DEN" / "LAL @ DEN" strings in
// every game-log table — visual recognition is much faster than reading.
export function MatchupCell({ opponentAbbr, isHome }: Props) {
  if (!opponentAbbr) return <span>—</span>;
  return (
    <span className="matchup-cell">
      <span className="matchup-marker">{isHome ? 'vs' : '@'}</span>
      <TeamLogo abbr={opponentAbbr} name={opponentAbbr} size="md" />
      <span className="matchup-abbr">{opponentAbbr}</span>
    </span>
  );
}
