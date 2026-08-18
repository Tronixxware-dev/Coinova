const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const logger = require('../config/logger');

const router = express.Router();

const MAX_SUBJECT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 5000;

const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: () => process.env.NODE_ENV === 'test',
});
router.use(supportLimiter);

// POST /api/support
router.post('/', requireAuth, async (req, res) => {
  const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';

  if (!subject || !message) {
    return res.status(400).json({ error: 'subject and message are required' });
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return res.status(400).json({ error: `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer` });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
  }

  try {
    const result = await pool.query(
      `INSERT INTO support_tickets (user_id, subject, message)
       VALUES ($1, $2, $3)
       RETURNING id, subject, message, status, created_at AS "createdAt"`,
      [req.user.id, subject, message]
    );
    res.status(201).json({ ticket: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Create support ticket error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/support — the trader's own submitted tickets, most recent first.
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, subject, message, status, created_at AS "createdAt"
       FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ tickets: result.rows });
  } catch (err) {
    logger.error({ err }, 'List support tickets error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;