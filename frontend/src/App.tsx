import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Compare } from './Compare';
import { ErrorBoundary } from './ErrorBoundary';
import { EspnGameDetail } from './EspnGameDetail';
import { GameDetail } from './GameDetail';
import { MlbCalibration } from './MlbCalibration';
import { MlbCompare } from './MlbCompare';
import { MlbPlayerLog } from './MlbPlayerLog';
import { MlbSlate } from './MlbSlate';
import { MlbStandings } from './MlbStandings';
import { Pricing } from './Pricing';
import { Slate } from './Slate';
import { Standings } from './Standings';

// Routes are sport-grouped per the UX spec: /nba/* and /mlb/*. Old
// flat routes (/compare, /slate, /standings) redirect to the
// sport-prefixed equivalents so existing bookmarks don't break.
// "Pages that don't exist yet" are deliberately NOT routed — per the
// mission's "no fake completeness" rule, /dashboard and /nba/research
// land when they're real, not as empty placeholders.
export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />

          {/* NBA — sport-grouped */}
          <Route path="/nba/compare" element={<Compare />} />
          <Route path="/nba/slate" element={<Slate />} />
          <Route path="/nba/standings" element={<Standings />} />

          {/* MLB — already mostly sport-grouped; canonical path
              for compare is now /mlb/compare. Old /mlb root
              redirects to it for back-compat. */}
          <Route path="/mlb/compare" element={<MlbCompare />} />
          <Route path="/mlb/slate" element={<MlbSlate />} />
          <Route path="/mlb/calibration" element={<MlbCalibration />} />
          <Route path="/mlb/standings" element={<MlbStandings />} />
          <Route path="/mlb/player/:playerId" element={<MlbPlayerLog />} />

          {/* Existing detail routes — sport-agnostic, leave as-is */}
          <Route path="/game/:gameId" element={<GameDetail />} />
          <Route path="/espn-game/:eventId" element={<EspnGameDetail />} />
          <Route path="/pricing" element={<Pricing />} />

          {/* Back-compat redirects from the old flat URLs. `replace`
              so users don't accumulate redirect history entries. */}
          <Route path="/compare" element={<Navigate to="/nba/compare" replace />} />
          <Route path="/slate" element={<Navigate to="/nba/slate" replace />} />
          <Route path="/standings" element={<Navigate to="/nba/standings" replace />} />
          <Route path="/mlb" element={<Navigate to="/mlb/compare" replace />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
