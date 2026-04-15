import { getDb } from '../db';

const FB_API = 'https://graph.facebook.com/v20.0';

export async function sendFacebookMessage(
  creds: Record<string, string>,
  recipientId: string,
  text: string,
  channelType: string
): Promise<string> {
  const token = creds.pageAccessToken;
  if (!token) throw new Error('Missing Facebook Page Access Token');

  let url: string;
  let body: Record<string, unknown>;

  if (channelType === 'messenger') {
    url = `${FB_API}/me/messages?access_token=${token}`;
    body = {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    };
  } else {
    // Page comment reply — reply to the comment
    url = `${FB_API}/${recipientId}/comments?access_token=${token}`;
    body = { message: text };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Facebook API error: ${err}`);
  }

  const data = await response.json() as { message_id?: string; id?: string };
  return data.message_id ?? data.id ?? '';
}

// Process an incoming Facebook webhook event and store in DB
export async function processFacebookWebhookEvent(
  userId: string,
  event: Record<string, unknown>,
  channelType: 'messenger' | 'page_comment'
): Promise<void> {
  const db = getDb();

  let senderId: string;
  let senderName: string;
  let text: string;
  let channelId: string;

  if (channelType === 'messenger') {
    const messaging = event as {
      sender: { id: string };
      message?: { mid: string; text: string };
    };
    if (!messaging.message?.text) return;
    senderId = messaging.sender.id;
    senderName = await getFacebookUserName(senderId, userId);
    text = messaging.message.text;
    channelId = senderId;
  } else {
    // Page comment
    const comment = event as {
      from: { id: string; name: string };
      message: string;
      comment_id?: string;
      post_id?: string;
    };
    if (!comment.message) return;
    senderId = comment.from.id;
    senderName = comment.from.name ?? 'Unknown';
    text = comment.message;
    channelId = comment.comment_id ?? comment.post_id ?? senderId;
  }

  // Upsert conversation
  const convResult = await db.query(
    `INSERT INTO conversations (user_id, channel_type, channel_id, contact_name, contact_id, unread_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, NOW())
     ON CONFLICT (user_id, channel_type, channel_id)
     DO UPDATE SET
       unread_count = conversations.unread_count + 1,
       updated_at = NOW()
     RETURNING id`,
    [userId, channelType, channelId, senderName, senderId]
  );

  const conversationId = convResult.rows[0].id;

  await db.query(
    `INSERT INTO messages (conversation_id, user_id, direction, text, channel_type, is_read)
     VALUES ($1, $2, 'incoming', $3, $4, FALSE)`,
    [conversationId, userId, text, channelType]
  );
}

async function getFacebookUserName(userId: string, accountUserId: string): Promise<string> {
  const db = getDb();
  try {
    const credsResult = await db.query(
      "SELECT value FROM user_credentials WHERE user_id = $1 AND channel = 'facebook' AND key = 'pageAccessToken'",
      [accountUserId]
    );
    if (credsResult.rowCount === 0) return 'Unknown';
    const token = credsResult.rows[0].value;
    const response = await fetch(`${FB_API}/${userId}?fields=name&access_token=${token}`);
    if (!response.ok) return 'Unknown';
    const data = await response.json() as { name?: string };
    return data.name ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}
