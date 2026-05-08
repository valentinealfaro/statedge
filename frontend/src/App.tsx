import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Compare } from './Compare';
import { ErrorBoundary } from './ErrorBoundary';
import { EspnGameDetail } from './EspnGameDetail';
import { GameDetail } from './GameDetail';
import { MlbCompare } from './MlbCompare';
import { MlbSlate } from './MlbSlate';
import { Pricing } from './Pricing';
import { Slate } from './Slate';
import { Standings } from './Standings';

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/game/:gameId" element={<GameDetail />} />
          <Route path="/espn-game/:eventId" element={<EspnGameDetail />} />
          <Route path="/standings" element={<Standings />} />
          <Route path="/slate" element={<Slate />} />
          <Route path="/mlb" element={<MlbCompare />} />
          <Route path="/mlb/slate" element={<MlbSlate />} />
          <Route path="/pricing" element={<Pricing />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
