import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db';
import crypto from 'crypto';

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Server misconfiguration' });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as { userId: string; email: string };

    // Verify session still exists in DB (allows server-side logout)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const db = getDb();
    const result = await db.query(
      'SELECT id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );

    if (result.rowCount === 0) {
      res.status(401).json({ error: 'Session expired or revoked' });
      return;
    }

    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
