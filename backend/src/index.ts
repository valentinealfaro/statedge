import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'statedge-backend' });
});

app.listen(port, () => {
  console.log(`StatEdge backend listening on http://localhost:${port}`);
});
