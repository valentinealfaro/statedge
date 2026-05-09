// Standalone NBA calibration page — Phase 84. Extracts the
// SlateCalibration tab from /nba/slate into its own route /nba/calibration
// so NBA matches MLB + WNBA's calibration surface area. Same component,
// just hosted in its own page chrome.

import { LatestNewsRail } from './LatestNewsRail';
import { NavBar } from './NavBar';
import { SlateCalibration } from './SlateCalibration';
import { useTitle } from './useTitle';

export function NbaCalibration() {
  useTitle(['NBA Calibration']);

  return (
    <div className="app">
      <NavBar />
      <div className="mlb-compare-shell">
        <h1>NBA · Calibration</h1>
        <p className="muted small">
          Predicted vs observed accuracy across the rolling window.
          Bayesian-smoothed hit rates so thin samples don't fake-claim
          accuracy. Pushes are excluded from the math.
        </p>
        <SlateCalibration />

        {/* NBA-scoped news rail — context for users auditing the model. */}
        <LatestNewsRail sport="nba" limit={4} heading="NBA Coverage" />
      </div>
    </div>
  );
}
