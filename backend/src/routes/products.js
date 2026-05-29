const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const cache = require('../cache');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');
const { err } = require('../middleware/error');
const { sanitizeText } = require('../utils/sanitize');
const { rewriteImageUrl } = require('../utils/cdn');
const { sendBackInStockEmail } = require('../utils/mailer');
const AutomaticOrderProcessor = require('../services/AutomaticOrderProcessor');

// GET /api/products - public browse (hides unscheduled / out-of-stock products)
router.get('/', (req, res) => {
  const products = db.prepare(`
    SELECT p.*, u.name AS farmer_name
    FROM products p
    JOIN users u ON p.farmer_id = u.id
    LEFT JOIN product_scheduling ps ON p.id = ps.product_id
    WHERE p.quantity > 0
      AND (ps.available_from IS NULL OR ps.available_from <= datetime('now'))
    ORDER BY p.created_at DESC
  `).all();
  res.json(products);
});

// GET /api/products/:id
router.get('/:id', (req, res) => {
  const product = db.prepare(`
    SELECT p.*, u.name AS farmer_name, u.stellar_public_key AS farmer_wallet
    FROM products p
    JOIN users u ON p.farmer_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // #616 — hide product if not yet available per scheduling
  const schedule = db.prepare('SELECT available_from FROM product_scheduling WHERE product_id = ?')
    .get(product.id);
  if (schedule && new Date(schedule.available_from) > new Date()) {
    return res.status(404).json({
      error: 'Product not yet available',
      available_from: schedule.available_from,
    });
  }

  res.json(product);
});

/**
 * @swagger
 * /api/products/{id}:
 *   get:
 *     summary: Get product by ID
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Product detail
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { $ref: '#/components/schemas/Product' }
 *       404:
 *         description: Product not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
/**
 * @swagger
 * /api/products:
 *   post:
 *     summary: Create a new product listing (farmer only)
 *     tags: [Products]
 */
// POST /api/products
router.post('/', auth, validate.product, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Only farmers can list products', 'forbidden');

  const { name, description, unit, category, image_url, nutrition } = req.body;
  const price = parseFloat(req.body.price);
  const quantity = parseInt(req.body.quantity, 10);

  if (!name || !name.trim()) return err(res, 400, 'Product name is required', 'validation_error');
  if (Number.isNaN(price) || price <= 0) return err(res, 400, 'Price must be a positive number', 'validation_error');
  if (Number.isNaN(quantity) || quantity < 1) return err(res, 400, 'Quantity must be a positive integer', 'validation_error');

  const preorder = normalizePreorderInput(req.body);
  if (preorder.error) return err(res, 400, preorder.error, 'validation_error');

  const { name, description, price, quantity, unit, weight_kg, available_from } = req.body;
  if (!name || !price || !quantity)
    return res.status(400).json({ error: 'name, price, quantity required' });

  const result = db.prepare(
    'INSERT INTO products (farmer_id, name, description, price, quantity, unit, weight_kg) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    req.user.id, name, description || '', price, quantity,
    unit || 'unit', weight_kg != null ? weight_kg : 1.0
  );

  const productId = result.lastInsertRowid;

  if (available_from) {
    db.prepare('INSERT INTO product_scheduling (product_id, available_from) VALUES (?, ?)').run(
      productId, available_from
    );
  }

  res.json({ id: productId, message: 'Product listed' });
});

// PUT /api/products/:id/schedule - farmer sets or updates pre-order availability
router.put('/:id/schedule', auth, (req, res) => {
  if (req.user.role !== 'farmer')
    return res.status(403).json({ error: 'Only farmers can schedule products' });

  const product = db.prepare('SELECT id FROM products WHERE id = ? AND farmer_id = ?')
    .get(req.params.id, req.user.id);
  if (!product) return res.status(404).json({ error: 'Product not found or not yours' });

  const { available_from } = req.body;
  if (!available_from)
    return res.status(400).json({ error: 'available_from required (ISO 8601 datetime)' });

  db.prepare(`
    INSERT INTO product_scheduling (product_id, available_from)
    VALUES (?, ?)
    ON CONFLICT(product_id) DO UPDATE SET available_from = excluded.available_from
  `).run(req.params.id, available_from);

  res.json({ message: 'Schedule updated', product_id: req.params.id, available_from });
});

// DELETE /api/products/:id/schedule - farmer removes scheduling (makes immediately available)
router.delete('/:id/schedule', auth, (req, res) => {
  if (req.user.role !== 'farmer')
    return res.status(403).json({ error: 'Farmers only' });

  const product = db.prepare('SELECT id FROM products WHERE id = ? AND farmer_id = ?')
    .get(req.params.id, req.user.id);
  if (!product) return res.status(404).json({ error: 'Product not found or not yours' });

  db.prepare('DELETE FROM product_scheduling WHERE product_id = ?').run(req.params.id);
  res.json({ message: 'Schedule removed, product is now immediately available' });
});

// GET /api/products/mine/list - farmer's own products (includes unscheduled ones)
router.get('/mine/list', auth, (req, res) => {
  if (req.user.role !== 'farmer')
    return res.status(403).json({ error: 'Farmers only' });

  const products = db.prepare(`
    SELECT p.*, ps.available_from
    FROM products p
    LEFT JOIN product_scheduling ps ON p.id = ps.product_id
    WHERE p.farmer_id = ?
    ORDER BY p.created_at DESC
  `).all(req.user.id);
  res.json(products);
});

// PATCH /api/products/:id
router.patch('/:id', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Only farmers can edit products', 'forbidden');

  const { rows: existing } = await db.query(
    'SELECT * FROM products WHERE id = $1 AND farmer_id = $2',
    [req.params.id, req.user.id]
  );
  if (!existing[0]) return err(res, 404, 'Not found or not yours', 'not_found');
  const product = existing[0];

  const allowed = [
    'name', 'description', 'price', 'quantity', 'unit', 'category',
    'low_stock_threshold', 'nutrition', 'pricing_type', 'min_weight', 'max_weight',
    'batch_id', 'is_preorder', 'preorder_delivery_date', 'allergens', 'allowed_regions',
    'grade', 'carbon_kg_per_unit', 'available_from', 'available_until',
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (Object.keys(updates).length === 0) return err(res, 400, 'No valid fields to update', 'validation_error');

  if (updates.name !== undefined) updates.name = sanitizeText(updates.name);
  if (updates.description !== undefined) updates.description = sanitizeText(updates.description);
  if (updates.unit !== undefined) updates.unit = sanitizeText(updates.unit);
  if (updates.category !== undefined) updates.category = sanitizeText(updates.category);
  if (updates.price !== undefined) {
    updates.price = parseFloat(updates.price);
    if (Number.isNaN(updates.price) || updates.price <= 0) return err(res, 400, 'Price must be a positive number', 'validation_error');
  }
  if (updates.quantity !== undefined) {
    updates.quantity = parseInt(updates.quantity, 10);
    if (Number.isNaN(updates.quantity) || updates.quantity < 0) return err(res, 400, 'Quantity must be non-negative', 'validation_error');
  }
  if (updates.low_stock_threshold !== undefined) {
    updates.low_stock_threshold = parseInt(updates.low_stock_threshold, 10);
    if (Number.isNaN(updates.low_stock_threshold) || updates.low_stock_threshold < 0) {
      return err(res, 400, 'Threshold must be non-negative', 'validation_error');
    }
  }
  if (updates.nutrition !== undefined) {
    updates.nutrition = updates.nutrition ? JSON.stringify(updates.nutrition) : null;
  }
  if (updates.allergens !== undefined) {
    const allergenResult = parseAndValidateAllergens(updates.allergens);
    if (allergenResult.error) return err(res, 400, allergenResult.error, 'validation_error');
    updates.allergens = allergenResult.allergens;
  }
  if (updates.allowed_regions !== undefined) {
    updates.allowed_regions = parseAllowedRegions(updates.allowed_regions);
  }
  if (updates.grade !== undefined) {
    const VALID_GRADES = ['A', 'B', 'C', 'Ungraded'];
    if (!VALID_GRADES.includes(updates.grade)) return err(res, 400, 'grade must be A, B, C, or Ungraded', 'validation_error');
  }
  if (updates.batch_id !== undefined) {
    if (updates.batch_id === null || updates.batch_id === '') {
      updates.batch_id = null;
    } else {
      const bid = parseInt(updates.batch_id, 10);
      if (Number.isNaN(bid) || bid < 1) return err(res, 400, 'batch_id must be a positive integer or null', 'validation_error');
      const { rows: bRows } = await db.query('SELECT id FROM harvest_batches WHERE id = $1 AND farmer_id = $2', [bid, req.user.id]);
      if (!bRows[0]) return err(res, 400, 'Invalid batch_id or not your batch', 'invalid_batch');
      updates.batch_id = bid;
    }
  }

  const nextIsPreorder = updates.is_preorder !== undefined
    ? (updates.is_preorder === true || updates.is_preorder === 1 || updates.is_preorder === '1')
    : !!product.is_preorder;
  const nextDeliveryDate = updates.preorder_delivery_date !== undefined
    ? (updates.preorder_delivery_date ? String(updates.preorder_delivery_date).trim() : null)
    : product.preorder_delivery_date;
  if (nextIsPreorder) {
    if (!nextDeliveryDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextDeliveryDate)) {
      return err(res, 400, 'preorder_delivery_date must be provided as YYYY-MM-DD for pre-order products', 'validation_error');
    }
    updates.is_preorder = 1;
    updates.preorder_delivery_date = nextDeliveryDate;
  } else {
    updates.is_preorder = 0;
    updates.preorder_delivery_date = null;
  }

  const newQty = updates.quantity ?? product.quantity;
  const newThreshold = updates.low_stock_threshold ?? product.low_stock_threshold ?? 5;
  if (newQty > newThreshold) updates.low_stock_alerted = 0;

  const keys = Object.keys(updates);
  const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await db.query(
    `UPDATE products SET ${setClauses} WHERE id = $${keys.length + 1}`,
    [...Object.values(updates), req.params.id]
  );

  if (updates.price !== undefined) {
    await db.query('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [req.params.id, updates.price]);
  }

  res.json({ success: true, message: 'Product updated' });
});

/**
 * @swagger
 * /api/products/{id}:
 *   delete:
 *     summary: Delete a product listing (farmer only)
 *     tags: [Products]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Product deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *       404:
 *         description: Not found or not yours
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Conflict - product has open or paid orders
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 error: { type: string }
 *                 code: { type: string }
 *                 openOrders: { type: array }
 */
// DELETE /api/products/:id
router.delete('/:id', auth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND farmer_id = ?')
    .get(req.params.id, req.user.id);
  if (!product) return res.status(404).json({ error: 'Not found or not yours' });
  db.prepare('DELETE FROM product_scheduling WHERE product_id = ?').run(req.params.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
module.exports.broadcastStockUpdate = broadcastStockUpdate;
