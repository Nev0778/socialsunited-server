import { Router, Response } from 'express';
import { getDb } from '../../db';
import { requireAuth, AuthRequest } from '../../middleware/auth';

const router = Router();

const FB_APP_ID = process.env.FACEBOOK_APP_ID ?? '';
const FB_APP_SECRET = process.env.FACEBOOK_APP_SECRET ?? '';
// The frontend URL that hosts the OAuth callback page
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'https://nev0778.github.io';
const REDIRECT_URI = `${process.env.BACKEND_URL ?? 'https://socialsunited-server.onrender.com'}/oauth/facebook/callback`;

// GET /oauth/facebook/start?token=<jwt>
// Redirects to Facebook OAuth dialog. We pass the JWT as state so we can
// identify the user when Facebook redirects back.
router.get('/start', (req: AuthRequest, res: Response) => {
  const userToken = req.query.token as string;
  if (!userToken) {
    res.status(400).send('Missing token');
    return;
  }

  const state = Buffer.from(JSON.stringify({ token: userToken })).toString('base64url');

  const params = new URLSearchParams({
    client_id: FB_APP_ID,
    redirect_uri: REDIRECT_URI,
    state,
    scope: 'pages_messaging,pages_read_engagement,pages_manage_metadata',
    response_type: 'code',
  });

  res.redirect(`https://www.facebook.com/dialog/oauth?${params.toString()}`);
});

// GET /oauth/facebook/callback
// Facebook redirects here after the user grants permission.
// We exchange the code for tokens, fetch the user's pages, and store credentials.
router.get('/callback', async (req: AuthRequest, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  const frontendCallbackUrl = `${FRONTEND_ORIGIN}/tradebuddynew/oauth/facebook`;

  if (error || !code) {
    res.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent(error ?? 'no_code')}`);
    return;
  }

  try {
    // Decode state to get the user's JWT
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const userToken = stateData.token as string;

    // Verify the JWT and get user ID
    const db = getDb();
    const crypto = await import('crypto');
    const tokenHash = crypto.createHash('sha256').update(userToken).digest('hex');
    const sessionResult = await db.query(
      'SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (sessionResult.rowCount === 0) {
      res.redirect(`${frontendCallbackUrl}?error=invalid_session`);
      return;
    }
    const userId = sessionResult.rows[0].user_id;

    // Exchange code for short-lived user access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
      new URLSearchParams({
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      })
    );
    const tokenData = await tokenRes.json() as { access_token?: string; error?: { message: string } };
    if (!tokenData.access_token) {
      throw new Error(tokenData.error?.message ?? 'Failed to get access token');
    }
    const shortLivedToken = tokenData.access_token;

    // Exchange for long-lived user access token
    const longRes = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: shortLivedToken,
      })
    );
    const longData = await longRes.json() as { access_token?: string; error?: { message: string } };
    if (!longData.access_token) {
      throw new Error(longData.error?.message ?? 'Failed to get long-lived token');
    }
    const longLivedUserToken = longData.access_token;

    // Fetch the user's pages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?access_token=${longLivedUserToken}`
    );
    const pagesData = await pagesRes.json() as {
      data?: Array<{ id: string; name: string; access_token: string }>;
      error?: { message: string };
    };

    if (!pagesData.data || pagesData.data.length === 0) {
      res.redirect(`${frontendCallbackUrl}?error=no_pages`);
      return;
    }

    // If the user has multiple pages, redirect with page list for them to choose
    if (pagesData.data.length > 1) {
      const pagesJson = Buffer.from(JSON.stringify(
        pagesData.data.map(p => ({ id: p.id, name: p.name, token: p.access_token }))
      )).toString('base64url');
      res.redirect(`${frontendCallbackUrl}?pages=${pagesJson}&user_token=${encodeURIComponent(userToken)}`);
      return;
    }

    // Single page — save automatically
    const page = pagesData.data[0];
    await saveFacebookCredentials(db, userId, page.id, page.name, page.access_token, FB_APP_ID, FB_APP_SECRET);

    res.redirect(`${frontendCallbackUrl}?success=1&page_name=${encodeURIComponent(page.name)}`);
  } catch (err) {
    console.error('Facebook OAuth callback error:', err);
    res.redirect(`${frontendCallbackUrl}?error=${encodeURIComponent(String(err))}`);
  }
});

// POST /oauth/facebook/select-page
// Called when user selects a page from the multi-page picker
router.post('/select-page', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  const { pageId, pageName, pageToken } = req.body as {
    pageId: string;
    pageName: string;
    pageToken: string;
  };

  if (!pageId || !pageName || !pageToken) {
    res.status(400).json({ error: 'Missing page details' });
    return;
  }

  try {
    const db = getDb();
    await saveFacebookCredentials(db, userId, pageId, pageName, pageToken, FB_APP_ID, FB_APP_SECRET);
    res.json({ success: true, pageName });
  } catch (err) {
    console.error('Facebook page selection error:', err);
    res.status(500).json({ error: 'Failed to save page credentials' });
  }
});

// GET /oauth/facebook/status
// Returns whether the current user has Facebook connected
router.get('/status', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  try {
    const db = getDb();
    const result = await db.query(
      "SELECT key, value FROM user_credentials WHERE user_id = $1 AND channel = 'facebook' AND key IN ('pageId', 'pageName')",
      [userId]
    );
    const data: Record<string, string> = {};
    for (const row of result.rows) {
      data[row.key] = row.value;
    }
    res.json({
      connected: !!data.pageId,
      pageId: data.pageId ?? null,
      pageName: data.pageName ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// DELETE /oauth/facebook/disconnect
// Removes all Facebook credentials for the current user
router.delete('/disconnect', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId!;
  try {
    const db = getDb();
    await db.query(
      "DELETE FROM user_credentials WHERE user_id = $1 AND channel = 'facebook'",
      [userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

async function saveFacebookCredentials(
  db: ReturnType<typeof getDb>,
  userId: string,
  pageId: string,
  pageName: string,
  pageAccessToken: string,
  appId: string,
  appSecret: string,
) {
  const credentials = [
    { key: 'pageId', value: pageId },
    { key: 'pageName', value: pageName },
    { key: 'pageAccessToken', value: pageAccessToken },
    { key: 'appId', value: appId },
    { key: 'appSecret', value: appSecret },
    { key: 'webhookVerifyToken', value: process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN ?? 'socialsunited_verify_2024' },
  ];

  for (const { key, value } of credentials) {
    await db.query(
      `INSERT INTO user_credentials (user_id, channel, key, value, updated_at)
       VALUES ($1, 'facebook', $2, $3, NOW())
       ON CONFLICT (user_id, channel, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [userId, key, value]
    );
  }
}

export default router;
