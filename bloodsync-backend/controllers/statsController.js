const Donor = require('../models/Donor');
const Request = require('../models/Request');

// GET /api/stats  (public, cached for 30 s so a busy homepage can't hammer the database)
// Real numbers for the homepage counters. Nothing personal is included.
const CACHE_MS = 30 * 1000;
let cache = null;

async function getStats(req, res) {
  if (cache && Date.now() - cache.at < CACHE_MS) return res.json(cache.value);

  const [activeDonors, registered, cityList, fulfilled, open, accepted] = await Promise.all([
    Donor.countDocuments({ status: 'active' }),
    Donor.countDocuments({}),
    Donor.distinct('city'),
    Request.countDocuments({ status: 'completed' }),
    Request.countDocuments({ status: { $in: ['searching', 'matched', 'in-transit'] } }),
    Request.find({ acceptedAt: { $ne: null } }).sort({ acceptedAt: -1 }).limit(200)
  ]);

  const cities = new Set(cityList.map((c) => String(c).trim().toLowerCase()).filter(Boolean)).size;
  const minutes = accepted
    .map((r) => (new Date(r.acceptedAt) - new Date(r.createdAt)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const avgMatchMinutes = minutes.length ? Math.max(1, Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length)) : null;

  const value = { activeDonors, registered, cities, fulfilled, open, avgMatchMinutes, updatedAt: new Date().toISOString() };
  cache = { at: Date.now(), value };
  res.json(value);
}

module.exports = { getStats };
