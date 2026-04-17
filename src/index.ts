import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { runMigrations } from './db';

// Routes
import authRouter from './routes/auth';
import credentialsRouter from './routes/credentials';
import conversationsRouter from './routes/conversations';
import userRouter from './routes/user';
import facebookWebhook from './routes/webhooks/facebook';
import facebookOAuth from './routes/oauth/facebook';
import whatsappWebhook from './routes/webhooks/whatsapp';
import twilioWebhook from './routes/webhooks/twilio';

const app = express();
const PORT = process.env.PORT ?? 3001;

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = [
  'https://nev0778.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
}));

// Rate limiting — stricter on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests, please try again later' },
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
});

app.use(generalLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
// Raw body needed for webhook signature verification
app.use('/webhooks', express.raw({ type: 'application/json' }));
app.use('/webhooks/twilio', express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/auth', authLimiter, authRouter);
app.use('/credentials', credentialsRouter);
app.use('/conversations', conversationsRouter);
app.use('/user', userRouter);

// ── OAuth Routes ─────────────────────────────────────────────────────────────
app.use('/oauth/facebook', facebookOAuth);

// ── Webhook Routes ────────────────────────────────────────────────────────────
app.use('/webhooks/facebook', facebookWebhook);
app.use('/webhooks/whatsapp', whatsappWebhook);
app.use('/webhooks/twilio', twilioWebhook);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await runMigrations();
    app.listen(PORT, () => {
      console.log(`SocialsUnited API running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
