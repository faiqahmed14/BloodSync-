const Request = require('../models/Request');
const { escalate } = require('../services/matchingEngine');

const WAVE_TIMEOUT_MS = Number(process.env.WAVE_TIMEOUT_MS) || 5 * 60 * 1000; // 5 minutes by default
const CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds

async function checkForTimedOutWaves() {
  const cutoff = new Date(Date.now() - WAVE_TIMEOUT_MS);

  const stalled = await Request.find({
    status: 'searching',
    waveStartedAt: { $lte: cutoff }
  });

  for (const request of stalled) {
    try {
      await escalate(request);
    } catch (err) {
      console.error(`Failed to escalate request ${request.requestId}:`, err.message);
    }
  }
}

function startWaveTimeoutChecker() {
  setInterval(() => {
    checkForTimedOutWaves().catch((err) =>
      console.error('Wave timeout check failed:', err.message)
    );
  }, CHECK_INTERVAL_MS);

  console.log(
    `Wave timeout checker running (timeout: ${WAVE_TIMEOUT_MS / 1000}s, checking every ${CHECK_INTERVAL_MS / 1000}s)`
  );
}

module.exports = { startWaveTimeoutChecker };
