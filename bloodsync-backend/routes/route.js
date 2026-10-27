const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { getRoute } = require('../services/routeService');

const router = express.Router();

function parsePoint(text) {
  const parts = String(text || '').split(',').map(Number);
  const [lng, lat] = parts;
  const ok =
    parts.length === 2 &&
    parts.every(Number.isFinite) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90;
  return ok ? [lng, lat] : null;
}

// GET /api/route?from=<lng>,<lat>&to=<lng>,<lat>
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const from = parsePoint(req.query.from);
    const to = parsePoint(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to must be "lng,lat" pairs' });
    }
    res.json(await getRoute(from, to));
  })
);

module.exports = router;
