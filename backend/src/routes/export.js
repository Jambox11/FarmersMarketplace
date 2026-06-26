const router = require('express').Router();
const { Readable, pipeline } = require('stream');
const { promisify } = require('util');
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

const pipelineAsync = promisify(pipeline);

const CSV_HEADERS = ['order_id', 'product_name', 'quantity', 'unit_price', 'total_xlm', 'buyer_name', 'status', 'created_at'];

function rowToCsvLine(row) {
  return CSV_HEADERS.map(h => {
    const v = String(row[h] ?? '');
    return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(',');
}

// GET /api/export/orders?format=csv|json&from=YYYY-MM-DD&to=YYYY-MM-DD[&farmer_id=:id]
router.get('/orders', auth, async (req, res) => {
  const { format = 'json', from, to } = req.query;

  if (!['csv', 'json'].includes(format))
    return err(res, 400, 'format must be csv or json', 'invalid_format');

  let farmerId = req.user.id;
  if (req.query.farmer_id) {
    if (req.user.role !== 'admin') return err(res, 403, 'Admins only', 'forbidden');
    farmerId = parseInt(req.query.farmer_id, 10);
    if (isNaN(farmerId)) return err(res, 400, 'Invalid farmer_id', 'validation_error');
  } else if (req.user.role !== 'farmer' && req.user.role !== 'admin') {
    return err(res, 403, 'Farmers only', 'forbidden');
  }

  const conditions = ['p.farmer_id = ?'];
  const params = [farmerId];

  if (from) { conditions.push('o.created_at >= ?'); params.push(from); }
  if (to)   { conditions.push('o.created_at <= ?'); params.push(to + ' 23:59:59'); }

  const sql = `
    SELECT o.id as order_id, p.name as product_name, o.quantity,
           p.price as unit_price, o.total_price as total_xlm,
           u.name as buyer_name, o.status, o.created_at
    FROM orders o
    JOIN products p ON o.product_id = p.id
    JOIN users u ON o.buyer_id = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY o.created_at DESC
  `;

  const rows = db.prepare(sql).all(...params);

  if (format === 'csv') {
    const month = (from || new Date().toISOString()).slice(0, 7);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=orders-${month}.csv`);

    if (rows.length > 1000) {
      // Stream large datasets
      let i = 0;
      const readable = new Readable({
        read() {
          if (i === 0) this.push(CSV_HEADERS.join(',') + '\n');
          if (i < rows.length) {
            this.push(rowToCsvLine(rows[i++]) + '\n');
          } else {
            this.push(null);
          }
        },
      });
      await pipelineAsync(readable, res);
    } else {
      const lines = [CSV_HEADERS.join(','), ...rows.map(rowToCsvLine)].join('\n');
      res.send(lines);
    }
  } else {
    res.json({ success: true, data: rows });
  }
});

module.exports = router;
