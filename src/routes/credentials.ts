import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getDb } from '../db';

const router = Router();

const CHANNEL_KEYS: Record<string, string[]> = {
  facebook: ['appId', 'appSecret', 'pageAccessToken', 'pageId'],
  whatsapp: ['phoneNumberId', 'accessToken', 'webhookVerifyToken', 'businessAccountId'],
  twilio: ['accountSid', 'authToken', 'phoneNumber'],
};

// GET /credentials — fetch all credentials for the logged-in user
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const db = getDb();
  try {
    const result = await db.query(
      'SELECT channel, key, value FROM user_credentials WHERE user_id = $1',
      [req.userId]
    );

    // Build structured object
    const creds: Record<string, Record<string, string>> = {
      facebook: { appId: '', appSecret: '', pageAccessToken: '', pageId: '' },
      whatsapp: { phoneNumberId: '', accessToken: '', webhookVerifyToken: '', businessAccountId: '' },
      twilio: { accountSid: '', authToken: '', phoneNumber: '' },
    };

    for (const row of result.rows) {
      if (creds[row.channel]) {
        creds[row.channel][row.key] = row.value;
      }
    }

    res.json(creds);
  } catch (err) {
    console.error('Fetch credentials error:', err);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// PUT /credentials — save/update credentials for the logged-in user
router.put('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { facebook, whatsapp, twilio } = req.body;
  const db = getDb();

  try {
    const updates: { channel: string; key: string; value: string }[] = [];

    for (const [channel, keys] of Object.entries(CHANNEL_KEYS)) {
      const channelData = { facebook, whatsapp, twilio }[channel] ?? {};
      for (const key of keys) {
        updates.push({ channel, key, value: channelData[key] ?? '' });
      }
    }

    // Upsert each credential
    for (const { channel, key, value } of updates) {
      await db.query(
        `INSERT INTO user_credentials (user_id, channel, key, value, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, channel, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [req.userId, channel, key, value]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Save credentials error:', err);
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

export default router;
