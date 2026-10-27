const Donor = require('../models/Donor');
const Notification = require('../models/Notification');
const Request = require('../models/Request');
const { emitBoardUpdate } = require('../sockets');
const { donorPreview, donorDetail } = require('../services/requestViews');
const { donorSelf } = require('../services/donorViews');
const { haversineMeters } = require('../services/routeService');

// POST /api/donors: register a new donor
async function createDonor(req, res) {
  const {
    name, age, gender, cnic, weightKg, bloodGroup,
    phone, city, address, coordinates,
    eligibility, willingFor, lastDonationDate
  } = req.body;

  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return res.status(400).json({ error: 'coordinates [lng, lat] are required' });
  }

  // 3-month cooldown check: if a last donation date is supplied and it's under
  // 90 days old, the donor starts life in cooldown rather than active.
  let status = 'active';
  let cooldownUntil = null;
  if (lastDonationDate) {
    const cooldownEnd = new Date(lastDonationDate);
    cooldownEnd.setDate(cooldownEnd.getDate() + 90);
    if (cooldownEnd > new Date()) {
      status = 'cooldown';
      cooldownUntil = cooldownEnd;
    }
  }

  const donor = await Donor.create({
    name, age, gender, cnic, weightKg, bloodGroup, phone, city, address,
    location: { type: 'Point', coordinates },
    eligibility,
    willingFor,
    lastDonationDate: lastDonationDate || null,
    status,
    cooldownUntil
  });

  emitBoardUpdate();
  res.status(201).json(donorSelf(donor));
}

// GET /api/donors/:id
async function getDonor(req, res) {
  const donor = await Donor.findById(req.params.id);
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  donor.refreshStatusIfCooldownExpired();
  if (donor.isModified()) await donor.save();

  res.json(donorSelf(donor));
}

// GET /api/donors: list with optional filters, for admin/testing use
// GET /api/donors  (ADMIN ONLY)
// This used to be public and returned full records (CNIC, phone, address) to anyone on the
// internet. It now answers 404 unless ADMIN_TOKEN is set in .env AND the request sends it in an
// `x-admin-token` header, and it never includes the CNIC or push subscription.
async function listDonors(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.get('x-admin-token') !== token) return res.status(404).json({ error: 'Not found' });

  const { city, bloodGroup, status } = req.query;
  const filter = {};
  if (city) filter.city = city;
  if (bloodGroup) filter.bloodGroup = bloodGroup;
  if (status) filter.status = status;

  const donors = await Donor.find(filter).limit(200).sort({ createdAt: -1 });
  res.json(donors.map(donorSelf));
}

// PATCH /api/donors/:id: update donor details
async function updateDonor(req, res) {
  const updatable = [
    'name', 'age', 'weightKg', 'phone', 'city', 'address',
    'eligibility', 'willingFor', 'status'
  ];
  const updates = {};
  for (const key of updatable) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  // A donor may only pause themselves ("inactive") or come back ("active"). "cooldown" is set by
  // the server alone, and a donor still inside their 3-month gap can't skip it by switching to
  // "active" (that used to be possible).
  if (updates.status !== undefined) {
    if (!['active', 'inactive'].includes(updates.status)) {
      return res.status(400).json({ error: 'status must be "active" or "inactive"' });
    }
    if (updates.status === 'active') {
      const current = await Donor.findById(req.params.id);
      if (!current) return res.status(404).json({ error: 'Donor not found' });
      if (current.cooldownUntil && current.cooldownUntil > new Date()) {
        return res.status(409).json({
          error: 'You are in your 3-month rest period, so alerts resume automatically afterwards.',
          cooldownUntil: current.cooldownUntil
        });
      }
    }
  }

  const donor = await Donor.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true
  });
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  // Status / blood group changes move the donor in or out of the live board counts.
  emitBoardUpdate();
  res.json(donorSelf(donor));
}

// POST /api/donors/:id/push-subscription: store a Web Push subscription
async function savePushSubscription(req, res) {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'a valid push subscription object is required' });
  }

  const donor = await Donor.findByIdAndUpdate(
    req.params.id,
    { pushSubscription: subscription },
    { new: true }
  );
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  res.json({ message: 'Push subscription saved', donorId: donor.donorId });
}

// GET /api/donors/:id/notifications: pending requests currently waiting on this donor.
// This is what a donor's own "Requests waiting on you" panel loads. It only returns a
// limited preview (blood group, hospital, reason, distance): the patient's name and
// contact numbers are released only after the donor accepts.
async function getMyNotifications(req, res) {
  const donor = await Donor.findById(req.params.id);
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  const notifications = await Notification.find({
    donorId: donor._id,
    response: 'pending'
  })
    .populate('requestId')
    .sort({ sentAt: -1 });

  // A notification can go stale (request matched by someone else, or cancelled)
  // without this donor's own Notification row being updated yet in edge cases,
  // filter defensively so a donor never sees a request that isn't actually open.
  const open = notifications.filter((n) => n.requestId && n.requestId.status === 'searching');

  res.json(
    open.map((n) => {
      const reqLoc = n.requestId.location && n.requestId.location.coordinates;
      const distance =
        reqLoc && donor.location && donor.location.coordinates
          ? haversineMeters(donor.location.coordinates, reqLoc)
          : null;
      return {
        notificationId: n._id,
        wave: n.wave,
        sentAt: n.sentAt,
        request: donorPreview(n.requestId, distance)
      };
    })
  );
}

// GET /api/donors/:id/active-request: the donation this donor has accepted and not
// yet finished (with full patient details), so the page can restore the map and live
// sharing after a refresh or when reopened from a notification.
async function getActiveRequest(req, res) {
  const request = await Request.findOne({
    acceptedDonorId: req.params.id,
    status: { $in: ['matched', 'in-transit'] }
  });
  if (!request) return res.json({ request: null });

  const donor = await Donor.findById(req.params.id);
  res.json({
    request: donorDetail(request),
    donor: donor ? { name: donor.name, donorId: donor.donorId, location: donor.location.coordinates } : null
  });
}

module.exports = {
  createDonor,
  getDonor,
  listDonors,
  updateDonor,
  savePushSubscription,
  getMyNotifications,
  getActiveRequest
};
