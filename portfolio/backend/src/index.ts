import express from 'express';
import { contactRouter, mailEnabled } from './contact.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), mail: mailEnabled() ? 'configured' : 'not configured' });
});

app.use('/api/contact', contactRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, HOST, () => {
  console.log(`portfolio backend listening on http://${HOST}:${PORT} (mail ${mailEnabled() ? 'configured' : 'not configured'})`);
});
