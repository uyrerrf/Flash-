'use strict';

function requireLogin(req, res, next) {
  if (req.session?.authed) return next();
  if (req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
}

function requireLoginWs(req) {
  return !!req.session?.authed;
}

module.exports = { requireLogin, requireLoginWs };
