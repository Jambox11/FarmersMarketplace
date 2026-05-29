const router = require('express').Router();
const logger = require('../logger');
const db = require('../db/schema');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const QRCode = require('qrcode');
const {
  sendPayment,
  pathPayment,
  getPathPaymentEstimate,
  getBalance,
  getPlatformFeeInfo,
  createClaimableBalance,
  claimBalance,
  mintRewardTokens,
  invokeEscrowContract,
  generatePaymentLink,
  getMemo,
} = require('../utils/stellar');
const {
  sendOrderEmails,
  sendLowStockAlert,
  sendStatusUpdateEmail,
} = require('../utils/mailer');
const { sendPushToUser } = require('../utils/pushNotifications');
const { err } = require('../middleware/error');
const { getCachedResponse, cacheResponse } = require('../utils/idempotency');
const { resolveCoupon, calcDiscount } = require('./coupons');
const { checkGeoFence } = require('../utils/geocheck');
const { broadcastStockUpdate } = require('./products');

// XLM per kg per km
const SHIPPING_RATE = 0.001;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// POST /api/orders - buyer places + pays for an order
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'buyer')
    return res.status(403).json({ error: 'Only buyers can place orders' });

  const { product_id, quantity, delivery_lat, delivery_lng } = req.body;
  if (!product_id || !quantity)
    return res.status(400).json({ error: 'product_id and quantity required' });

  const product = db.prepare(`
    SELECT p.*, u.stellar_public_key AS farmer_wallet, u.farm_lat, u.farm_lng
    FROM products p JOIN users u ON p.farmer_id = u.id
    WHERE p.id = ?
  `).get(product_id);

  if (coupon_code) {
    const { coupon, error, code: errCode } = resolveCoupon(coupon_code, product.farmer_id, req.user.id);
    if (!error) {
       discount = calcDiscount(coupon, subtotal);
       appliedCoupon = coupon;
    }
  }

  // Bundle discount: count distinct products this buyer is ordering from the same farmer
  let bundleDiscount = 0;
  let appliedBundleDiscount = null;
  try {
    const { rows: pendingItems } = await db.query(
      `SELECT COUNT(DISTINCT product_id) as cnt FROM orders
       WHERE buyer_id = $1 AND status = 'pending'
         AND product_id IN (SELECT id FROM products WHERE farmer_id = $2)`,
      [req.user.id, product.farmer_id],
    );
    // +1 for the current product being ordered
    const distinctProducts = parseInt(pendingItems[0]?.cnt || 0, 10) + 1;
    if (distinctProducts >= 2) {
      const { rows: tiers } = await db.query(
        `SELECT * FROM bundle_discounts WHERE farmer_id = $1 AND min_products <= $2
         ORDER BY min_products DESC LIMIT 1`,
        [product.farmer_id, distinctProducts],
      );
      if (tiers[0]) {
        appliedBundleDiscount = tiers[0];
        bundleDiscount = parseFloat(((subtotal - discount) * tiers[0].discount_percent / 100).toFixed(7));
      }
    }
  } catch {
    // bundle_discounts table may not exist yet — skip silently
  }

  const totalPrice = parseFloat((subtotal - discount - bundleDiscount).toFixed(7));

  // #616 — reject if product is not yet available per scheduling
  const schedule = db.prepare('SELECT available_from FROM product_scheduling WHERE product_id = ?')
    .get(product_id);
  if (schedule && new Date(schedule.available_from) > new Date()) {
    return res.status(400).json({
      error: 'Product not yet available for order',
      available_from: schedule.available_from,
    });
  }

  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const itemTotal = product.price * quantity;

  // #617 — weight-based shipping cost
  let shippingCost = 0;
  if (
    delivery_lat != null && delivery_lng != null &&
    product.farm_lat != null && product.farm_lng != null
  ) {
    const distKm = haversineKm(product.farm_lat, product.farm_lng, delivery_lat, delivery_lng);
    const totalWeightKg = (product.weight_kg || 1.0) * quantity;
    shippingCost = parseFloat((totalWeightKg * distKm * SHIPPING_RATE).toFixed(7));
  }

  const grandTotal = parseFloat((itemTotal + shippingCost).toFixed(7));

  const order = db.prepare(
    'INSERT INTO orders (buyer_id, product_id, quantity, total_price, shipping_cost, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, product_id, quantity, grandTotal, shippingCost, 'pending');

  const { rows: orderRows } = await db.query(
    `INSERT INTO orders (buyer_id, product_id, quantity, total_price, custom_price, status, address_id) 
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.user.id, product_id, quantity, totalPrice, custom_price || null, 'pending', address_id || null]
  );
  const orderId = orderRows[0].id;

  if (payment_method === 'sep7') {
    if (appliedCoupon) {
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(appliedCoupon.id);
      db.prepare('INSERT INTO coupon_uses (coupon_id, user_id) VALUES (?, ?)').run(appliedCoupon.id, req.user.id);
    }

    const responseData = {
      success: true,
      orderId,
      status: 'pending',
      totalPrice,
      message: 'Order created for SEP-0007 payment',
    };

    if (idempotencyKey) cacheResponse(idempotencyKey, responseData);
    return res.json(responseData);
  }

  // 5. Payment Processing
  try {
    const txHash = await sendPayment({
      senderSecret: buyer.stellar_secret_key,
      receiverPublicKey: product.farmer_wallet,
      amount: grandTotal,
      memo: `Order#${orderId}`,
    });

    db.prepare('UPDATE orders SET status = ?, stellar_tx_hash = ? WHERE id = ?').run('paid', txHash, orderId);
    db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?').run(quantity, product_id);

    res.json({ orderId, status: 'paid', txHash, itemTotal, shippingCost, grandTotal });
  } catch (err) {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('failed', orderId);
    res.status(402).json({ error: 'Payment failed: ' + err.message, orderId });
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const { rows: countRows } = await db.query(`SELECT COUNT(*) as count FROM orders o ${where}`, params);
  const total = parseInt(countRows[0].count, 10);

  const { rows: data } = await db.query(
    `SELECT o.*, p.name as product_name, p.unit, p.is_preorder, p.preorder_delivery_date, u.name as farmer_name,
            hb.batch_code as harvest_batch_code, hb.harvest_date as harvest_batch_date, hb.notes as harvest_batch_notes,
            a.label as address_label, a.street as address_street, a.city as address_city,
            a.country as address_country, a.postal_code as address_postal_code,
            rr.status as return_status, rr.reason as return_reason, rr.reject_reason, rr.refund_tx_hash
     FROM orders o
     JOIN products p ON o.product_id = p.id
     JOIN users u ON p.farmer_id = u.id
     LEFT JOIN harvest_batches hb ON hb.id = p.batch_id
     LEFT JOIN addresses a ON o.address_id = a.id
     LEFT JOIN return_requests rr ON rr.order_id = o.id
     ${where}
     ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  // Enrich paid orders with memo; use cached value or fetch from Horizon
  await Promise.all(data.map(async (o) => {
    if (o.status !== 'paid' || !o.stellar_tx_hash) return;
    if (o.stellar_memo) return;
    const memo = await getMemo(o.stellar_tx_hash);
    if (memo) {
      o.stellar_memo = memo;
      db.query('UPDATE orders SET stellar_memo = $1 WHERE id = $2', [memo, o.id]).catch(() => {});
    }
  }));

  res.json({ success: true, data, total, page, limit, totalPages: Math.ceil(total / limit) });
});

/**
 * @swagger
 * /api/orders/sales:
 *   get:
 *     summary: Get farmer's incoming sales
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated sales list
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/PaginatedResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/Order' }
 *       403:
 *         description: Farmers only
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
// GET /api/orders/sales
router.get('/sales', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) as count FROM orders o JOIN products p ON o.product_id = p.id WHERE p.farmer_id = $1`,
    [req.user.id],
  );
  const total = parseInt(countRows[0].count, 10);

  const { rows: data } = await db.query(
    `SELECT o.*, p.name as product_name, p.is_preorder, p.preorder_delivery_date, u.name as buyer_name,
            hb.batch_code as harvest_batch_code, hb.harvest_date as harvest_batch_date, hb.notes as harvest_batch_notes,
            a.label as address_label, a.street as address_street, a.city as address_city,
            a.country as address_country, a.postal_code as address_postal_code,
            rr.status as return_status, rr.reason as return_reason, rr.reject_reason, rr.refund_tx_hash
     FROM orders o
     JOIN products p ON o.product_id = p.id
     JOIN users u ON o.buyer_id = u.id
     LEFT JOIN harvest_batches hb ON hb.id = p.batch_id
     LEFT JOIN addresses a ON o.address_id = a.id
     LEFT JOIN return_requests rr ON rr.order_id = o.id
     WHERE p.farmer_id = $1
     ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset],
  );

  // Enrich paid orders with memo; use cached value or fetch from Horizon
  await Promise.all(data.map(async (o) => {
    if (o.status !== 'paid' || !o.stellar_tx_hash) return;
    if (o.stellar_memo) return;
    const memo = await getMemo(o.stellar_tx_hash);
    if (memo) {
      o.stellar_memo = memo;
      db.query('UPDATE orders SET stellar_memo = $1 WHERE id = $2', [memo, o.id]).catch(() => {});
    }
  }));

  res.json({ success: true, data, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// PATCH /api/orders/:id/status
router.patch('/:id/status', auth, validate.updateOrderStatus, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const { status } = req.body;
  const { rows } = await db.query(
    `SELECT o.*, p.name as product_name, p.unit, u.name as buyer_name, u.email as buyer_email
     FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON o.buyer_id = u.id
     WHERE o.id = $1 AND p.farmer_id = $2`,
    [req.params.id, req.user.id]
  );
  const order = rows[0];
  if (!order) return err(res, 404, 'Order not found or not yours', 'not_found');

  await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, order.id]);

  sendStatusUpdateEmail({
    order,
    product: { name: order.product_name, unit: order.unit },
    buyer: { name: order.buyer_name, email: order.buyer_email },
    newStatus: status,
  }).catch((e) => logger.error('Status email failed:', { error: e.message }));

  sendPushToUser(order.buyer_id, {
    title: 'Order status updated',
    body: `Order #${order.id} is now ${status}`,
    url: '/orders',
  }).catch((pushErr) => console.error('Push notification failed:', pushErr.message));
  }).catch((pushErr) => logger.error('Push notification failed:', { error: pushErr.message }));

  res.json({ success: true, message: 'Order status updated' });
});

// POST /api/orders/:id/escrow — buyer funds escrow (legacy flow)
// POST /api/orders/:id/escrow
router.post('/:id/escrow', auth, async (req, res) => {
  if (req.user.role !== 'buyer') return err(res, 403, 'Only buyers can fund escrow', 'forbidden');

  const { rows } = await db.query(
    `SELECT o.*, p.farmer_id, u.stellar_public_key as farmer_wallet
     FROM orders o JOIN products p ON o.product_id = p.id JOIN users u ON p.farmer_id = u.id
     WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return err(res, 404, 'Order not found', 'not_found');

  await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, order.id]);
  sendStatusUpdateEmail({ order, product: { name: order.product_name, unit: order.unit }, buyer: { name: order.buyer_name, email: order.buyer_email }, newStatus: status }).catch(e => console.error('[Mail] fail:', e.message));
  sendPushToUser(order.buyer_id, { title: 'Order Status', body: `Order #${order.id} is now ${status}`, url: '/orders' }).catch(e => console.error('[Push] fail:', e.message));
  res.json({ success: true, message: 'Status updated' });
});

// GET /api/orders - buyer's order history
router.get('/', auth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, p.name AS product_name, p.unit, u.name AS farmer_name
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users u ON p.farmer_id = u.id
    WHERE o.buyer_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(orders);
});

// GET /api/orders/sales - farmer's incoming orders
router.get('/sales', auth, (req, res) => {
  if (req.user.role !== 'farmer')
    return res.status(403).json({ error: 'Farmers only' });

  const sales = db.prepare(`
    SELECT o.*, p.name AS product_name, u.name AS buyer_name
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users u ON o.buyer_id = u.id
    WHERE p.farmer_id = ?
    ORDER BY o.created_at DESC
  `).all(req.user.id);
  res.json(sales);
});

module.exports = router;

