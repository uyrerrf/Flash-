'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const path   = require('path');

let _hash = null;
(async () => {
  const pass = process.env.ADMIN_PASS || 'changeme';
  _hash = await bcrypt.hash(pass, 12);
})();

const USER = process.env.ADMIN_USER || 'admin';

router.get('/login', (req, res) => {
  if (req.session?.authed) return res.redirect('/');
  res.sendFile('login.html', { root: path.join(__dirname, '../public') });
});

router.post('/login', async (req, res) => {
  const { user, pass } = req.body;
  if (!user || !pass) return res.status(400).json({ error: 'Missing fields' });
  if (user !== USER || !_hash) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(pass, _hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.authed = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
