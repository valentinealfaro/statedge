import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Home } from './Home';
import { Compare } from './Compare';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/compare" element={<Compare />} />
      </Routes>
    </BrowserRouter>
  );
}
