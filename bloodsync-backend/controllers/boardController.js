const Donor = require('../models/Donor');

// GET /api/board: live counts of active donors per blood group,
// optionally scoped to a city. Feeds the Live Availability Board on the frontend.
async function getBoard(req, res) {
  const { city } = req.query;
  const match = { status: 'active' };
  if (city) match.city = city;

  const counts = await Donor.aggregate([
    { $match: match },
    { $group: { _id: '$bloodGroup', count: { $sum: 1 } } }
  ]);

  const board = { 'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0, 'AB+': 0, 'AB-': 0, 'O+': 0, 'O-': 0 };
  for (const row of counts) board[row._id] = row.count;

  res.json({ city: city || 'all', board });
}

module.exports = { getBoard };
