import { Router, Request, Response } from 'express';
import { getDb } from '../../db';
import { processFacebookWebhookEvent } from '../../services/facebook';
import crypto from 'crypto';

const router = Router();

// GET /webhooks/facebook — Meta webhook verification
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe') {
    res.status(403).send('Forbidden');
    return;
  }

  // Find a user whose Facebook webhook verify token matches
  const db = getDb();
  const result = await db.query(
    "SELECT user_id FROM user_credentials WHERE channel = 'facebook' AND key = 'webhookVerifyToken' AND value = $1 LIMIT 1",
    [token]
  );

  if (result.rowCount === 0) {
    res.status(403).send('Forbidden');
    return;
  }

  res.status(200).send(challenge);
});

// POST /webhooks/facebook — incoming messages and page comments
router.post('/', async (req: Request, res: Response): Promise<void> => {
  // Acknowledge immediately (Meta requires fast response)
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    const db = getDb();

    for (const entry of body.entry ?? []) {
      const pageId = entry.id;

      // Find which user owns this page
      const userResult = await db.query(
        "SELECT user_id FROM user_credentials WHERE channel = 'facebook' AND key = 'pageId' AND value = $1 LIMIT 1",
        [pageId]
      );
      if (userResult.rowCount === 0) continue;
      const userId = userResult.rows[0].user_id;

      // Messenger messages
      for (const event of entry.messaging ?? []) {
        if (event.message && !event.message.is_echo) {
          await processFacebookWebhookEvent(userId, event, 'messenger');
        }
      }

      // Page comments (feed)
      for (const change of entry.changes ?? []) {
        if (change.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
          await processFacebookWebhookEvent(userId, change.value, 'page_comment');
        }
      }
    }
  } catch (err) {
    console.error('Facebook webhook processing error:', err);
  }
});

export default router;
