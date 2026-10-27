const Donor = require('../models/Donor');

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const EARTH_RADIUS_KM = 6378.1;

// GET /api/reach?lng=&lat=&type=replacement|direct-need&bloodGroup=O+
// "How many donors would be alerted?" shown while someone fills in the request form. It counts
// exactly the donors the matching engine would pick from (active; the exact group for direct-need,
// and only donors willing for any request), and returns counts only, never any personal data.
async function getReach(req, res) {
  const lng = Number(req.query.lng);
  const lat = Number(req.query.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    return res.status(400).json({ error: 'lng and lat are required' });
  }

  const base = { status: 'active' };
  if (req.query.type === 'direct-need') {
    if (!GROUPS.includes(req.query.bloodGroup)) return res.status(400).json({ error: 'bloodGroup is required for direct-need' });
    base.bloodGroup = req.query.bloodGroup;
    base.willingFor = 'any';
  }

  const within = (km) => ({ ...base, location: { $geoWithin: { $centerSphere: [[lng, lat], km / EARTH_RADIUS_KM] } } });
  const [within5km, within15km, total] = await Promise.all([
    Donor.countDocuments(within(5)),
    Donor.countDocuments(within(15)),
    Donor.countDocuments(base)
  ]);

  res.json({ within5km, within15km, total });
}

module.exports = { getReach };
