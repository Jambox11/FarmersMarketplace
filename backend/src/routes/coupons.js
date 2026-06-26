const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

// Schema migrations for coupons feature
db.exec(`
  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    discount_pct REAL NOT NULL CHECK(discount_pct > 0 AND discount_pct <= 100),
    max_uses INTEGER NOT NULL DEFAULT 1,
    max_uses_per_user INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    order_id INTEGER,
    redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (coupon_id) REFERENCES coupons(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// POST /api/coupons/validate - validate a coupon code for the requesting buyer
router.post('/validate', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return err(res, 400, 'Coupon code is required', 'validation_error');

  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
  if (!coupon) return err(res, 404, 'Coupon not found', 'coupon_not_found');

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date())
    return err(res, 400, 'Coupon has expired', 'coupon_expired');

  if (coupon.used_count >= coupon.max_uses)
    return err(res, 409, 'Coupon has reached its maximum uses', 'coupon_exhausted');

  const userUses = db.prepare(
    'SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?'
  ).get(coupon.id, req.user.id).count;

  if (userUses >= coupon.max_uses_per_user)
    return err(res, 409, 'You have already used this coupon the maximum number of times', 'coupon_user_limit_reached');

  res.json({ success: true, data: { id: coupon.id, discount_pct: coupon.discount_pct } });
});

// POST /api/coupons/redeem - atomically redeem a coupon (call after order is created)
router.post('/redeem', auth, (req, res) => {
  const { code, order_id } = req.body;
  if (!code || !order_id) return err(res, 400, 'code and order_id are required', 'validation_error');

  const redeem = db.transaction(() => {
    const coupon = db.prepare('SELECT * FROM coupons WHERE code = ?').get(code);
    if (!coupon) throw { status: 404, message: 'Coupon not found', code: 'coupon_not_found' };

    if (coupon.expires_at && new Date(coupon.expires_at) < new Date())
      throw { status: 400, message: 'Coupon has expired', code: 'coupon_expired' };

    const userUses = db.prepare(
      'SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?'
    ).get(coupon.id, req.user.id).count;

    if (userUses >= coupon.max_uses_per_user)
      throw { status: 409, message: 'You have already used this coupon the maximum number of times', code: 'coupon_user_limit_reached' };

    // Race-condition-safe increment: only succeeds if used_count < max_uses
    const result = db.prepare(
      'UPDATE coupons SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses'
    ).run(coupon.id);

    if (result.changes === 0)
      throw { status: 409, message: 'Coupon has reached its maximum uses', code: 'coupon_exhausted' };

    db.prepare(
      'INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES (?, ?, ?)'
    ).run(coupon.id, req.user.id, order_id);

    return { discount_pct: coupon.discount_pct };
  });

  try {
    const result = redeem();
    res.json({ success: true, data: result });
  } catch (e) {
    if (e.status) return err(res, e.status, e.message, e.code);
    throw e;
  }
});

// POST /api/coupons - admin create coupon
router.post('/', auth, (req, res) => {
  if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
  const { code, discount_pct, max_uses = 1, max_uses_per_user = 1, expires_at } = req.body;
  if (!code || !discount_pct) return err(res, 400, 'code and discount_pct are required', 'validation_error');

  try {
    const result = db.prepare(
      'INSERT INTO coupons (code, discount_pct, max_uses, max_uses_per_user, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(code.toUpperCase(), discount_pct, max_uses, max_uses_per_user, expires_at || null);
    res.status(201).json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return err(res, 409, 'Coupon code already exists', 'code_taken');
    throw e;
  }
});

module.exports = router;
