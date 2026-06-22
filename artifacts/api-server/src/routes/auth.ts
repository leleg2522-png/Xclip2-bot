import { Router, type IRouter } from 'express';

const COOKIE_NAME = 'invite_session';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

const router: IRouter = Router();

router.post('/invite-auth/login', (req, res) => {
  const secret = process.env.INVITE_PANEL_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'INVITE_PANEL_SECRET is not configured on the server.' });
    return;
  }

  const { secret: provided } = req.body as { secret?: string };
  if (!provided || provided !== secret) {
    res.status(401).json({ error: 'Invalid secret.' });
    return;
  }

  res.cookie(COOKIE_NAME, secret, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE_MS,
    secure: process.env.NODE_ENV === 'production',
  });
  res.json({ ok: true });
});

router.post('/invite-auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true });
});

export default router;
