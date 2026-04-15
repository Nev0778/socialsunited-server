import { Router, Response, Request } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { getDb } from '../db';
import { sendFacebookMessage } from '../services/facebook';
import { sendWhatsAppMessage } from '../services/whatsapp';
import { sendSmsMessage } from '../services/twilio';

const router = Router();

// GET /conversations — list all conversations for the user
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const db = getDb();
  try {
    const result = await db.query(
      `SELECT c.*,
        (SELECT row_to_json(m) FROM (
          SELECT id, direction, text, channel_type, is_read, created_at
          FROM messages WHERE conversation_id = c.id
          ORDER BY created_at DESC LIMIT 1
        ) m) AS last_message
       FROM conversations c
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /conversations/:id/messages — get messages in a conversation
router.get('/:id/messages', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const db = getDb();
  try {
    // Verify ownership
    const conv = await db.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (conv.rowCount === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const messages = await db.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );

    // Mark all as read
    await db.query(
      'UPDATE messages SET is_read = TRUE WHERE conversation_id = $1 AND direction = $2',
      [req.params.id, 'incoming']
    );
    await db.query(
      'UPDATE conversations SET unread_count = 0 WHERE id = $1',
      [req.params.id]
    );

    res.json(messages.rows);
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /conversations/:id/messages — send a reply
router.post('/:id/messages', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { text } = req.body;
  if (!text?.trim()) {
    res.status(400).json({ error: 'Message text is required' });
    return;
  }

  const db = getDb();
  try {
    // Get conversation and verify ownership
    const convResult = await db.query(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (convResult.rowCount === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const conv = convResult.rows[0];

    // Get user credentials for this channel
    const credsResult = await db.query(
      'SELECT key, value FROM user_credentials WHERE user_id = $1 AND channel = $2',
      [req.userId, conv.channel_type === 'page_comment' ? 'facebook' : conv.channel_type]
    );
    const creds: Record<string, string> = {};
    for (const row of credsResult.rows) {
      creds[row.key] = row.value;
    }

    // Send via the appropriate channel
    let channelMsgId: string | undefined;
    try {
      if (conv.channel_type === 'messenger' || conv.channel_type === 'page_comment') {
        channelMsgId = await sendFacebookMessage(creds, conv.contact_id, text.trim(), conv.channel_type);
      } else if (conv.channel_type === 'whatsapp') {
        channelMsgId = await sendWhatsAppMessage(creds, conv.contact_id, text.trim());
      } else if (conv.channel_type === 'sms') {
        channelMsgId = await sendSmsMessage(creds, conv.contact_id, text.trim());
      }
    } catch (sendErr) {
      console.error('Channel send error:', sendErr);
      res.status(502).json({ error: 'Failed to send message via channel. Check your API credentials.' });
      return;
    }

    // Store in DB
    const msgResult = await db.query(
      `INSERT INTO messages (conversation_id, user_id, direction, text, channel_type, channel_msg_id, is_read)
       VALUES ($1, $2, 'outgoing', $3, $4, $5, TRUE)
       RETURNING *`,
      [conv.id, req.userId, text.trim(), conv.channel_type, channelMsgId ?? null]
    );

    await db.query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [conv.id]
    );

    res.status(201).json(msgResult.rows[0]);
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// PATCH /conversations/:id/read — mark conversation as read
router.patch('/:id/read', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const db = getDb();
  try {
    await db.query(
      'UPDATE conversations SET unread_count = 0 WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    await db.query(
      'UPDATE messages SET is_read = TRUE WHERE conversation_id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

export default router;
