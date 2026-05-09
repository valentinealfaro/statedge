// Standalone NBA slate history page — Phase 94. Extracts the
// SlateHistory tab from /nba/slate into its own route /nba/slate/history
// so NBA matches MLB + WNBA's history surface area. Same component,
// hosted in its own page chrome.

import { NavBar } from './NavBar';
import { SlateHistory } from './SlateHistory';
import { useTitle } from './useTitle';

export function NbaSlateHistory() {
  useTitle(['NBA Slate History']);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>NBA · Slate History</h1>
        <p className="muted small">
          Past published slates with hit-rate tracking. Each row is one
          calendar day; legs are graded against actual game outcomes
          once games finalize. The model's accountability surface —
          you see the wins and the losses, no cherry-picking.
        </p>
        <SlateHistory />
      </div>
    </div>
  );
}
