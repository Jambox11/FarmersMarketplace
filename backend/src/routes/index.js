const router = require('express').Router();
const rateLimit = require('express-rate-limit');

const authLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts, try again later' } });
const orderLimiter = rateLimit({ windowMs: 60 * 1000,       max: 10, message: { error: 'Too many orders, slow down' } });
const fundLimiter  = rateLimit({ windowMs: 60 * 60 * 1000,  max: 5,  message: { error: 'Funding limit reached, try again in an hour' } });
const sendLimiter  = rateLimit({ windowMs: 60 * 1000,       max: 5,  message: { error: 'Too many send requests, slow down' } });

// Rate limiters scoped to versioned paths
router.use('/api/v1/auth/login',    authLimiter);
router.use('/api/v1/auth/register', authLimiter);
router.use('/api/v1/orders',        orderLimiter);
router.use('/api/v1/wallet/fund',   fundLimiter);
router.use('/api/auth/login',    authLimiter);
router.use('/api/auth/register', authLimiter);
router.use('/api/auth/refresh',  authLimiter);
router.use('/api/orders',        orderLimiter);
router.use('/api/wallet/fund',   fundLimiter);
router.use('/api/wallet/send',   sendLimiter);

// Versioned routes under /api/v1
router.use('/api/v1/auth',     require('./auth'));
router.use('/api/v1/products', require('./products'));
router.use('/api/v1/orders',   require('./orders'));
router.use('/api/v1/wallet',   require('./wallet'));

router.get('/api/v1/health', (_, res) => res.json({ status: 'ok', version: 'v1' }));

router.use('/api/coupons',    require('./coupons'));
router.use('/api/export',     require('./export'));
router.use('/api/categories', require('./categories'));
router.use('/api/reviews',    require('./reviews'));

module.exports = router;
