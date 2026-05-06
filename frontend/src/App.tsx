import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Compare } from './Compare';
import { ErrorBoundary } from './ErrorBoundary';
import { GameDetail } from './GameDetail';

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/game/:gameId" element={<GameDetail />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
