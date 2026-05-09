import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Compare } from './Compare';
import { Dashboard } from './Dashboard';
import { CalibrationAudit } from './CalibrationAudit';
import { ClvAudit } from './ClvAudit';
import { ErrorBoundary } from './ErrorBoundary';
import { EspnGameDetail } from './EspnGameDetail';
import { GameDetail } from './GameDetail';
import { MlbCalibration } from './MlbCalibration';
import { MlbCompare } from './MlbCompare';
import { MlbGameDetail } from './MlbGameDetail';
import { MlbPlayerLog } from './MlbPlayerLog';
import { MlbSlate } from './MlbSlate';
import { MlbSlateHistory } from './MlbSlateHistory';
import { MlbStandings } from './MlbStandings';
import { MmaFighter } from './MmaFighter';
import { MmaScoreboard } from './MmaScoreboard';
import { MmaSlate } from './MmaSlate';
import { NbaCalibration } from './NbaCalibration';
import { NbaSlateHistory } from './NbaSlateHistory';
import { News } from './News';
import { NewsArticle } from './NewsArticle';
import { PlayerLog } from './PlayerLog';
import { Pricing } from './Pricing';
import { Slate } from './Slate';
import { Standings } from './Standings';
import { WnbaCalibration } from './WnbaCalibration';
import { WnbaCompare } from './WnbaCompare';
import { WnbaGameDetail } from './WnbaGameDetail';
import { WnbaSlate } from './WnbaSlate';
import { WnbaSlateHistory } from './WnbaSlateHistory';
import { WnbaStandings } from './WnbaStandings';

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
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/clv" element={<ClvAudit />} />
          <Route path="/calibration" element={<CalibrationAudit />} />

          {/* NBA — sport-grouped */}
          <Route path="/nba/compare" element={<Compare />} />
          <Route path="/nba/slate" element={<Slate />} />
          <Route path="/nba/slate/history" element={<NbaSlateHistory />} />
          <Route path="/nba/standings" element={<Standings />} />
          <Route path="/nba/calibration" element={<NbaCalibration />} />
          <Route path="/nba/player/:playerId" element={<PlayerLog />} />

          {/* MLB — already mostly sport-grouped; canonical path
              for compare is now /mlb/compare. Old /mlb root
              redirects to it for back-compat. */}
          <Route path="/mlb/compare" element={<MlbCompare />} />
          <Route path="/mlb/slate" element={<MlbSlate />} />
          <Route path="/mlb/slate/history" element={<MlbSlateHistory />} />
          <Route path="/mlb/calibration" element={<MlbCalibration />} />
          <Route path="/mlb/standings" element={<MlbStandings />} />
          <Route path="/mlb/player/:playerId" element={<MlbPlayerLog />} />
          <Route path="/mlb/game/:gamePk" element={<MlbGameDetail />} />

          {/* WNBA — Phase 74 foundation. Standings is shipped; the
              other surfaces (compare/slate/calibration/game) land in
              subsequent phases. */}
          <Route path="/wnba/standings" element={<WnbaStandings />} />
          <Route path="/wnba/compare" element={<WnbaCompare />} />
          <Route path="/wnba/slate" element={<WnbaSlate />} />
          <Route path="/wnba/slate/history" element={<WnbaSlateHistory />} />
          <Route path="/wnba/calibration" element={<WnbaCalibration />} />
          <Route path="/wnba/game/:eventId" element={<WnbaGameDetail />} />
          <Route path="/wnba" element={<Navigate to="/wnba/compare" replace />} />

          {/* MMA — Phase 107 foundation. UFC scoreboard only for now;
              fighter profiles + odds integration land in subsequent
              phases. Replaces WNBA as the third sport per priorities. */}
          <Route path="/mma" element={<MmaScoreboard />} />
          <Route path="/mma/scoreboard" element={<MmaScoreboard />} />
          <Route path="/mma/slate" element={<MmaSlate />} />
          <Route path="/mma/fighter/:fighterId" element={<MmaFighter />} />

          {/* News — Phase 104. Auto-generated articles, public SEO. */}
          <Route path="/news" element={<News />} />
          <Route path="/news/:slug" element={<NewsArticle />} />

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
