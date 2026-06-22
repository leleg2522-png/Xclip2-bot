import type { Request, Response, NextFunction } from 'express';

const COOKIE_NAME = 'invite_session';

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.INVITE_PANEL_SECRET;

  if (!secret) {
    res.status(503).json({
      error: 'INVITE_PANEL_SECRET env var is not configured on the server.',
    });
    return;
  }

  const sessionValue = req.cookies?.[COOKIE_NAME] as string | undefined;

  if (!sessionValue || sessionValue !== secret) {
    res.status(401).json({ error: 'Not authenticated. Please log in.' });
    return;
  }

  next();
}
