import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { searchRouter } from './routes/search.js';
import { teamsRouter } from './routes/teams.js';
import { compareRouter } from './routes/compare.js';

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'statedge-backend' });
});

app.use('/api/search', searchRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/compare', compareRouter);

app.listen(port, () => {
  console.log(`StatEdge backend listening on http://localhost:${port}`);
});
