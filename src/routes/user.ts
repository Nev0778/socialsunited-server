import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getDb } from '../db';

const router = Router();

// PATCH /user/profile — update business name
router.patch('/profile', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { businessName } = req.body;
  if (businessName === undefined) {
    res.status(400).json({ error: 'businessName is required' });
    return;
  }

  const db = getDb();
  try {
    await db.query(
      'UPDATE users SET business_name = $1, updated_at = NOW() WHERE id = $2',
      [businessName.trim(), req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
