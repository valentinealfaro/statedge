import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Compare } from './Compare';
import { ErrorBoundary } from './ErrorBoundary';

export function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/compare" element={<Compare />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
