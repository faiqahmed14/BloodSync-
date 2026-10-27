const mongoose = require('mongoose');
const Donor = require('../models/Donor');

/**
 * Finds the nearest eligible donors for a request, excluding anyone already notified.
 *
 * - direct-need requests only consider donors of the exact blood group needed.
 * - replacement requests consider every active donor regardless of blood group.
 * - Donors currently in cooldown (donated within the last 90 days) are excluded
 *   entirely by filtering on status: 'active'.
 */
async function findNearestDonors(request, limit) {
  const excludeIds = (request.notifiedDonorIds || []).map(
    (id) => new mongoose.Types.ObjectId(id)
  );

  const matchStage = {
    status: 'active',
    _id: { $nin: excludeIds }
  };
  if (request.type === 'direct-need') {
    matchStage.bloodGroup = request.bloodGroup;
    // Donors who chose "Replacement requests only" must not be pinged for
    // direct-need (rare group / empty stock) requests.
    matchStage.willingFor = 'any';
  }

  const donors = await Donor.aggregate([
    {
      $geoNear: {
        near: request.location,
        distanceField: 'distanceMeters',
        spherical: true,
        query: matchStage
      }
    },
    { $limit: limit }
  ]);

  return donors;
}

module.exports = { findNearestDonors };
