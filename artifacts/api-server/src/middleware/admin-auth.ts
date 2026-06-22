import type { Request, Response, NextFunction } from 'express';

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.INVITE_PANEL_SECRET;

  if (!secret) {
    res.status(503).json({
      error: 'INVITE_PANEL_SECRET env var is not configured. Set it to a strong random token.',
    });
    return;
  }

  const auth = req.headers['authorization'] ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (!token || token !== secret) {
    res.status(401).json({ error: 'Unauthorized. Valid Bearer token required.' });
    return;
  }

  next();
}
