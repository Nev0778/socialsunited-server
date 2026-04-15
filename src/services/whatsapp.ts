import { getDb } from '../db';

const WA_API = 'https://graph.facebook.com/v20.0';

export async function sendWhatsAppMessage(
  creds: Record<string, string>,
  to: string,
  text: string
): Promise<string> {
  const { phoneNumberId, accessToken } = creds;
  if (!phoneNumberId || !accessToken) throw new Error('Missing WhatsApp credentials');

  const response = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`WhatsApp API error: ${err}`);
  }

  const data = await response.json() as { messages?: { id: string }[] };
  return data.messages?.[0]?.id ?? '';
}

export async function processWhatsAppWebhookEvent(
  userId: string,
  message: Record<string, unknown>
): Promise<void> {
  const db = getDb();

  const msg = message as {
    from: string;
    id: string;
    type: string;
    text?: { body: string };
    profile?: { name: string };
  };

  if (msg.type !== 'text' || !msg.text?.body) return;

  const senderPhone = msg.from;
  const senderName = msg.profile?.name ?? senderPhone;
  const text = msg.text.body;

  const convResult = await db.query(
    `INSERT INTO conversations (user_id, channel_type, channel_id, contact_name, contact_id, unread_count, updated_at)
     VALUES ($1, 'whatsapp', $2, $3, $4, 1, NOW())
     ON CONFLICT (user_id, channel_type, channel_id)
     DO UPDATE SET
       unread_count = conversations.unread_count + 1,
       contact_name = CASE WHEN conversations.contact_name = conversations.contact_id THEN EXCLUDED.contact_name ELSE conversations.contact_name END,
       updated_at = NOW()
     RETURNING id`,
    [userId, senderPhone, senderName, senderPhone]
  );

  const conversationId = convResult.rows[0].id;

  await db.query(
    `INSERT INTO messages (conversation_id, user_id, direction, text, channel_type, channel_msg_id, is_read)
     VALUES ($1, $2, 'incoming', $3, 'whatsapp', $4, FALSE)`,
    [conversationId, userId, text, msg.id]
  );
}
