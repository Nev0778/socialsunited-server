import { Router, Request, Response } from 'express';
import { getDb } from '../../db';
import { processWhatsAppWebhookEvent } from '../../services/whatsapp';

const router = Router();

// GET /webhooks/whatsapp — Meta webhook verification
router.get('/', async (req: Request, res: Response): Promise<void> => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe') {
    res.status(403).send('Forbidden');
    return;
  }

  const db = getDb();
  const result = await db.query(
    "SELECT user_id FROM user_credentials WHERE channel = 'whatsapp' AND key = 'webhookVerifyToken' AND value = $1 LIMIT 1",
    [token]
  );

  if (result.rowCount === 0) {
    res.status(403).send('Forbidden');
    return;
  }

  res.status(200).send(challenge);
});

// POST /webhooks/whatsapp — incoming WhatsApp messages
router.post('/', async (req: Request, res: Response): Promise<void> => {
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const db = getDb();

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // Find which user owns this phone number
        const userResult = await db.query(
          "SELECT user_id FROM user_credentials WHERE channel = 'whatsapp' AND key = 'phoneNumberId' AND value = $1 LIMIT 1",
          [phoneNumberId]
        );
        if (userResult.rowCount === 0) continue;
        const userId = userResult.rows[0].user_id;

        for (const message of value.messages ?? []) {
          // Attach profile name if available
          const contact = (value.contacts ?? []).find(
            (c: { wa_id: string; profile?: { name: string } }) => c.wa_id === message.from
          );
          if (contact) {
            message.profile = contact.profile;
          }
          await processWhatsAppWebhookEvent(userId, message);
        }
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook processing error:', err);
  }
});

export default router;
