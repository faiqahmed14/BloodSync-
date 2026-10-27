const Request = require('../models/Request');
const Notification = require('../models/Notification');
const { findNearestDonors } = require('./geoService');
const { notifyDonorsOfRequest } = require('./pushService');
const { emitDonorNewRequest } = require('../sockets');
const { donorPreview } = require('./requestViews');

const FIRST_WAVE_SIZE = 20;

function nextWaveSize(currentWave) {
  if (currentWave < 20) return 20;
  if (currentWave < 50) return 50;
  if (currentWave < 100) return 100;
  if (currentWave < 200) return 200;
  return 200; // beyond 200, keep expanding by another 200 each time, indefinitely
}

/**
 * Notifies a batch of donors for a request: records a Notification per donor,
 * sends the actual push, and updates the request's own bookkeeping fields.
 * Returns false if there were no more eligible donors left to notify at all.
 */
async function notifyWave(request, waveSize) {
  const donors = await findNearestDonors(request, waveSize);
  if (donors.length === 0) return false;

  const donorIds = donors.map((d) => d._id);

  await Notification.insertMany(
    donorIds.map((donorId) => ({
      requestId: request._id,
      donorId,
      wave: waveSize,
      response: 'pending'
    })),
    { ordered: false }
  ).catch(() => {
    // duplicate key errors are fine here, a donor already notified in an
    // earlier wave simply won't be re-inserted, thanks to the unique index
  });

  // 1) In-page pop-up for donors who have BloodSync open right now (instant, free).
  for (const d of donors) {
    try {
      emitDonorNewRequest(d._id, { request: donorPreview(request, d.distanceMeters) });
    } catch (err) {
      console.error('Socket alert failed:', err.message);
    }
  }

  // 2) Web Push for donors whose browser is closed. A push failure must never stop
  //    the wave bookkeeping below, so it is isolated here.
  try {
    await notifyDonorsOfRequest(donors, request);
  } catch (err) {
    console.error(`Push step failed for request ${request.requestId}:`, err.message);
  }

  request.notifiedDonorIds = [...(request.notifiedDonorIds || []), ...donorIds];
  request.wave = waveSize;
  request.waveStartedAt = new Date();
  await request.save();

  return true;
}

// Called immediately when a new request is created.
async function startMatching(requestId) {
  const request = await Request.findById(requestId);
  if (!request) return;

  const foundAny = await notifyWave(request, FIRST_WAVE_SIZE);
  if (!foundAny) {
    request.status = 'no-donors-available';
    await request.save();
  }
}

// Called by the wave-timeout job when a wave's 5 minutes have passed with no acceptance.
async function escalate(request) {
  const size = nextWaveSize(request.wave);
  const foundAny = await notifyWave(request, size);
  if (!foundAny) {
    request.status = 'no-donors-available';
    await request.save();
  }
}

module.exports = { startMatching, escalate, nextWaveSize };
