import { Router, Request, Response } from 'express';
import { getDb } from '../../db';
import { processTwilioWebhookEvent } from '../../services/twilio';

const router = Router();

// POST /webhooks/twilio — incoming SMS from Twilio
// Twilio sends form-encoded POST with From, To, Body, MessageSid etc.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  // Respond with empty TwiML immediately
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  try {
    const params = req.body as Record<string, string>;
    const toNumber = params.To;
    if (!toNumber) return;

    // Find which user owns this Twilio number
    const db = getDb();
    const userResult = await db.query(
      "SELECT user_id FROM user_credentials WHERE channel = 'twilio' AND key = 'phoneNumber' AND value = $1 LIMIT 1",
      [toNumber]
    );
    if (userResult.rowCount === 0) return;
    const userId = userResult.rows[0].user_id;

    await processTwilioWebhookEvent(userId, params);
  } catch (err) {
    console.error('Twilio webhook processing error:', err);
  }
});

export default router;
