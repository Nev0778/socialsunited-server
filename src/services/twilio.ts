import { getDb } from '../db';

export async function sendSmsMessage(
  creds: Record<string, string>,
  to: string,
  text: string
): Promise<string> {
  const { accountSid, authToken, phoneNumber } = creds;
  if (!accountSid || !authToken || !phoneNumber) throw new Error('Missing Twilio credentials');

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const body = new URLSearchParams({
    To: to,
    From: phoneNumber,
    Body: text,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Twilio API error: ${err}`);
  }

  const data = await response.json() as { sid: string };
  return data.sid ?? '';
}

export async function processTwilioWebhookEvent(
  userId: string,
  params: Record<string, string>
): Promise<void> {
  const db = getDb();

  const from = params.From;
  const body = params.Body;
  const messageSid = params.MessageSid;

  if (!from || !body) return;

  // Try to get a name from existing conversations, otherwise use the number
  const existing = await db.query(
    "SELECT contact_name FROM conversations WHERE user_id = $1 AND channel_type = 'sms' AND channel_id = $2",
    [userId, from]
  );
  const contactName = existing.rows[0]?.contact_name ?? from;

  const convResult = await db.query(
    `INSERT INTO conversations (user_id, channel_type, channel_id, contact_name, contact_id, unread_count, updated_at)
     VALUES ($1, 'sms', $2, $3, $4, 1, NOW())
     ON CONFLICT (user_id, channel_type, channel_id)
     DO UPDATE SET
       unread_count = conversations.unread_count + 1,
       updated_at = NOW()
     RETURNING id`,
    [userId, from, contactName, from]
  );

  const conversationId = convResult.rows[0].id;

  await db.query(
    `INSERT INTO messages (conversation_id, user_id, direction, text, channel_type, channel_msg_id, is_read)
     VALUES ($1, $2, 'incoming', $3, 'sms', $4, FALSE)`,
    [conversationId, userId, body, messageSid]
  );
}
