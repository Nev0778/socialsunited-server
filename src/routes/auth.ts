import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDb } from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();
const TOKEN_EXPIRY_DAYS = 30;

function generateToken(userId: string, email: string): string {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ userId, email }, secret, { expiresIn: `${TOKEN_EXPIRY_DAYS}d` });
}

// POST /auth/signup
router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  const { email, password, businessName } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const emailLower = email.toLowerCase().trim();
  const db = getDb();

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [emailLower]);
    if ((existing.rowCount ?? 0) > 0) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await db.query(
      'INSERT INTO users (email, password_hash, business_name) VALUES ($1, $2, $3) RETURNING id, email, business_name, created_at',
      [emailLower, passwordHash, businessName?.trim() || '']
    );
    const user = userResult.rows[0];

    const token = generateToken(user.id, user.email);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await db.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        businessName: user.business_name,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();
  const db = getDb();

  try {
    const result = await db.query(
      'SELECT id, email, password_hash, business_name FROM users WHERE email = $1',
      [emailLower]
    );

    if (result.rowCount === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = generateToken(user.id, user.email);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await db.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        businessName: user.business_name,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization!;
  const token = authHeader.slice(7);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const db = getDb();

  try {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const db = getDb();
  try {
    const result = await db.query(
      'SELECT id, email, business_name, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const user = result.rows[0];
    res.json({
      id: user.id,
      email: user.email,
      businessName: user.business_name,
      createdAt: user.created_at,
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
