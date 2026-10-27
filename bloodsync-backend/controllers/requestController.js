const crypto = require('crypto');
const Request = require('../models/Request');
const Donor = require('../models/Donor');
const Notification = require('../models/Notification');
const { startMatching } = require('../services/matchingEngine');
const { notifyRequestFilled, notifyRequestCancelled } = require('../services/pushService');
const { donorDetail, requesterView } = require('../services/requestViews');
const { haversineMeters } = require('../services/routeService');
const {
  emitRequestStatus,
  emitRequestMatched,
  emitDonorLocation,
  emitDonorRequestClosed,
  emitBoardUpdate
} = require('../sockets');

// Rough ETA: straight-line distance divided by an assumed average city
// travel speed. Good enough for an estimate; the live tracking page refines it
// with real routing once the donor's GPS is flowing.
const ASSUMED_KMH = 22;

function estimateEtaMinutes(distanceMeters) {
  if (!distanceMeters && distanceMeters !== 0) return null;
  const km = distanceMeters / 1000;
  return Math.max(4, Math.round((km / ASSUMED_KMH) * 60));
}

const ACTIVE_DONATION = ['matched', 'in-transit'];
const CANCELLABLE = ['searching', 'matched', 'in-transit', 'no-donors-available'];
const CANCEL_REASONS = ['donor-not-found', 'arranged-locally', 'no-longer-needed', 'other'];

function validCoords(c) {
  return (
    Array.isArray(c) &&
    c.length === 2 &&
    c.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Math.abs(c[0]) <= 180 &&
    Math.abs(c[1]) <= 90
  );
}

function tokensMatch(a, b) {
  if (!a || !b) return false;
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// POST /api/requests: submit a blood request. Kicks off the matching
// engine immediately, which alerts the first wave of donors.
async function createRequest(req, res) {
  const {
    type, patient, bloodGroup, unitsRequired, reason,
    hospital, doctor, requester, coordinates, notes, locationSource
  } = req.body;

  if (!validCoords(coordinates)) {
    return res.status(400).json({ error: 'coordinates [lng, lat] for the hospital are required' });
  }
  if (!['direct-need', 'replacement'].includes(type)) {
    return res.status(400).json({ error: 'type must be "direct-need" or "replacement"' });
  }

  const request = await Request.create({
    type, patient, bloodGroup, unitsRequired, reason,
    hospital, doctor, requester, notes,
    locationSource: ['gps', 'geocoded', 'city-fallback'].includes(locationSource)
      ? locationSource
      : 'city-fallback',
    location: { type: 'Point', coordinates }
  });

  // Fire and forget: the requester doesn't wait on notification delivery to get
  // their 201 response back. Status updates arrive over the socket + polling.
  startMatching(request._id).catch((err) =>
    console.error(`Matching engine failed for request ${request.requestId}:`, err.message)
  );

  // The secret token is returned exactly once, here, to the person who created the
  // request. Every other endpoint leaves it out.
  res.status(201).json({ ...requesterView(request), requesterToken: request.requesterToken });
}

// GET /api/requests/:id: poll status (used by requester's tracking screen)
async function getRequest(req, res) {
  const request = await Request.findById(req.params.id)
    .populate('acceptedDonorId', 'name bloodGroup phone donorId');
  if (!request) return res.status(404).json({ error: 'Request not found' });
  res.json(requesterView(request));
}

// PATCH /api/requests/:id/accept: a donor accepts. Race-safe: only the
// first accept for a still-"searching" request succeeds. The response is the one
// place the patient's details and contact numbers are handed out.
async function acceptRequest(req, res) {
  const { donorId } = req.body;
  if (!donorId) return res.status(400).json({ error: 'donorId is required' });

  const donor = await Donor.findById(donorId);
  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  donor.refreshStatusIfCooldownExpired();
  if (donor.status !== 'active') {
    return res.status(403).json({ error: 'You are not currently eligible to donate' });
  }

  // One donation at a time.
  const busy = await Request.findOne({ acceptedDonorId: donor._id, status: { $in: ACTIVE_DONATION } });
  if (busy) {
    return res.status(409).json({ error: 'You already have an active donation in progress' });
  }

  // Only a donor this request was actually sent to may accept it. A donor whose invitation
  // was already "withdrawn" (because someone else got there first) is still allowed to reach
  // the check below, so they get the clear "already matched" message rather than a vague 403.
  const invitation = await Notification.findOne({
    requestId: req.params.id,
    donorId: donor._id,
    response: { $in: ['pending', 'declined', 'withdrawn'] }
  });
  if (!invitation) {
    return res.status(403).json({ error: 'This request was not sent to you' });
  }

  const request = await Request.findOneAndUpdate(
    { _id: req.params.id, status: 'searching' }, // guard: only if still open
    { status: 'matched', acceptedDonorId: donor._id, acceptedAt: new Date() },
    { new: true }
  );

  if (!request) {
    return res.status(409).json({ error: 'Request already matched, completed, or cancelled' });
  }

  // Mark this donor's notification accepted, withdraw everyone else's for this request
  await Notification.updateMany({ requestId: request._id, donorId: donor._id }, { response: 'accepted' });
  const withdrawn = await Notification.find({
    requestId: request._id,
    donorId: { $ne: donor._id },
    response: 'pending'
  });
  await Notification.updateMany(
    { requestId: request._id, donorId: { $ne: donor._id }, response: 'pending' },
    { response: 'withdrawn' }
  );

  // Tell everyone else asked that the request is already filled (push + live pop-up)
  const withdrawnIds = withdrawn.map((n) => n.donorId);
  emitDonorRequestClosed(withdrawnIds, request._id, 'filled');
  notifyRequestFilled(withdrawnIds, request._id).catch((err) =>
    console.error('Failed to notify withdrawn donors:', err.message)
  );

  const donorCoords = donor.location && donor.location.coordinates;
  const etaMinutes =
    donorCoords && request.location
      ? estimateEtaMinutes(haversineMeters(donorCoords, request.location.coordinates))
      : null;

  emitRequestMatched(request._id, donor, etaMinutes);
  emitRequestStatus(request._id, 'matched');

  res.json({
    request: donorDetail(request),
    donor: { name: donor.name, donorId: donor.donorId, location: donorCoords || null },
    etaMinutes
  });
}

// PATCH /api/requests/:id/decline: a specific donor declines this wave
async function declineRequest(req, res) {
  const { donorId } = req.body;
  if (!donorId) return res.status(400).json({ error: 'donorId is required' });

  await Notification.updateOne(
    { requestId: req.params.id, donorId, response: 'pending' },
    { response: 'declined' }
  );

  res.json({ message: 'Decline recorded' });
}

// PATCH /api/requests/:id/start-transit: the accepted donor is now heading to the hospital
async function startTransit(req, res) {
  const { donorId } = req.body;
  if (!donorId) return res.status(400).json({ error: 'donorId is required' });

  const request = await Request.findOneAndUpdate(
    { _id: req.params.id, status: 'matched', acceptedDonorId: donorId },
    { status: 'in-transit' },
    { new: true }
  );
  if (!request) return res.status(409).json({ error: 'Request is not in a matched state for this donor' });

  emitRequestStatus(request._id, 'in-transit');
  res.json({ status: request.status });
}

// PATCH /api/requests/:id/location: the accepted donor's device pings its current
// location; relayed live to the requester's tracking screen over the socket.
async function updateLocation(req, res) {
  const { donorId, coordinates } = req.body;
  if (!donorId) return res.status(400).json({ error: 'donorId is required' });
  if (!validCoords(coordinates)) {
    return res.status(400).json({ error: 'coordinates [lng, lat] are required' });
  }

  const now = new Date();
  const request = await Request.findOneAndUpdate(
    { _id: req.params.id, acceptedDonorId: donorId, status: { $in: ACTIVE_DONATION } },
    { donorCurrentLocation: { type: 'Point', coordinates, updatedAt: now } },
    { new: true }
  );
  if (!request) {
    // Tells the donor's device to stop sharing (request done, cancelled, or not theirs).
    return res.status(409).json({ error: 'This request is no longer active for you' });
  }

  emitDonorLocation(request._id, coordinates, now);
  res.json({ message: 'Location updated' });
}

// PATCH /api/requests/:id/complete: donation finished, start donor cooldown.
// Either the accepted donor or the requester (with their token) may confirm it.
async function completeRequest(req, res) {
  const { donorId, requesterToken } = req.body;

  const request = await Request.findById(req.params.id).select('+requesterToken');
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (!request.acceptedDonorId) {
    return res.status(400).json({ error: 'Request has no accepted donor to complete' });
  }

  const isDonor = donorId && String(request.acceptedDonorId) === String(donorId);
  const isRequester = tokensMatch(requesterToken, request.requesterToken);
  if (!isDonor && !isRequester) {
    return res.status(403).json({ error: 'Only the accepted donor or the requester can complete this request' });
  }
  if (!ACTIVE_DONATION.includes(request.status)) {
    return res.status(409).json({ error: `Request is already ${request.status}` });
  }

  request.status = 'completed';
  request.completedAt = new Date();
  await request.save();

  const cooldownUntil = new Date();
  cooldownUntil.setDate(cooldownUntil.getDate() + 90); // 3-month gap

  await Donor.findByIdAndUpdate(request.acceptedDonorId, {
    lastDonationDate: new Date(),
    cooldownUntil,
    status: 'cooldown',
    $inc: { donationCount: 1 }
  });

  emitRequestStatus(request._id, 'completed');
  emitBoardUpdate(); // that donor just left the active pool

  res.json({ message: 'Request completed, donor cooldown started', cooldownUntil });
}

// PATCH /api/requests/:id/cancel: "Cancel My Request".
// Used when no donor turned up, blood was arranged locally, it's no longer needed,
// or any other reason. Only the browser that created the request holds the token.
async function cancelRequest(req, res) {
  const { requesterToken, reason, note } = req.body;

  if (!CANCEL_REASONS.includes(reason)) {
    return res.status(400).json({ error: `reason must be one of: ${CANCEL_REASONS.join(', ')}` });
  }
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 300) : '';
  if (reason === 'other' && !cleanNote) {
    return res.status(400).json({ error: 'Please tell us why you are cancelling' });
  }

  const existing = await Request.findById(req.params.id).select('+requesterToken');
  if (!existing) return res.status(404).json({ error: 'Request not found' });
  if (!tokensMatch(requesterToken, existing.requesterToken)) {
    return res.status(403).json({ error: 'Only the person who created this request can cancel it' });
  }
  if (!CANCELLABLE.includes(existing.status)) {
    return res.status(409).json({ error: `This request is already ${existing.status}` });
  }

  // Atomic: if a donor accepts at the very same moment, the status guard still holds.
  const request = await Request.findOneAndUpdate(
    { _id: existing._id, status: { $in: CANCELLABLE } },
    { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, cancelNote: cleanNote },
    { new: true }
  );
  if (!request) return res.status(409).json({ error: 'This request just changed state. Please refresh' });

  // Withdraw every still-open invitation and tell those donors (and the accepted
  // donor, if there was one), live pop-up + push, so nobody travels for nothing.
  const pending = await Notification.find({ requestId: request._id, response: 'pending' });
  await Notification.updateMany({ requestId: request._id, response: 'pending' }, { response: 'withdrawn' });

  const toTell = pending.map((n) => n.donorId);
  if (request.acceptedDonorId) toTell.push(request.acceptedDonorId);

  emitRequestStatus(request._id, 'cancelled', { reason, note: cleanNote });
  emitDonorRequestClosed(toTell, request._id, 'cancelled', { cancelReason: reason });
  notifyRequestCancelled(toTell, request._id, { acceptedDonorId: request.acceptedDonorId }).catch((err) =>
    console.error('Failed to push cancellation:', err.message)
  );

  res.json({ message: 'Request cancelled', status: 'cancelled' });
}

module.exports = {
  createRequest,
  getRequest,
  acceptRequest,
  declineRequest,
  startTransit,
  updateLocation,
  completeRequest,
  cancelRequest
};
