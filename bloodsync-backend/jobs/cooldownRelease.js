const Donor = require('../models/Donor');
const { emitBoardUpdate } = require('../sockets');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// A donor's 3-month rest period used to end only when their own record happened to be fetched, so
// on a long-running server donors stayed "in cooldown" (not alerted, not counted on the board)
// long after their gap was over. This releases them on a schedule instead.
async function releaseExpiredCooldowns() {
  const result = await Donor.updateMany(
    { status: 'cooldown', cooldownUntil: { $lte: new Date() } },
    { status: 'active', cooldownUntil: null }
  );
  if (result && result.modifiedCount > 0) {
    console.log(`Released ${result.modifiedCount} donor(s) from cooldown`);
    emitBoardUpdate();
  }
}

function startCooldownRelease() {
  const run = () => releaseExpiredCooldowns().catch((err) => console.error('Cooldown release failed:', err.message));
  run();
  setInterval(run, CHECK_INTERVAL_MS).unref();
}

module.exports = { startCooldownRelease, releaseExpiredCooldowns };
