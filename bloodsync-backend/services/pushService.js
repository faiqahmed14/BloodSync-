const webpush = require('web-push');
const Donor = require('../models/Donor');

let configured = false;
let warnedNotConfigured = false;

// Returns false (instead of throwing) when VAPID keys are missing, so a missing key
// can never abort the matching engine half-way through a wave.
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    if (!warnedNotConfigured) {
      console.warn(
        'Web Push is disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set. ' +
          'Run `npm run generate-vapid-keys` and copy the output into .env. ' +
          'In-page pop-up alerts still work.'
      );
      warnedNotConfigured = true;
    }
    return false;
  }
  webpush.setVapidDetails(
    `mailto:${VAPID_CONTACT_EMAIL || 'admin@example.com'}`,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
}

/**
 * Sends a push notification to a single donor. If the donor has no saved
 * subscription yet (common during early testing/demoing), this is skipped
 * rather than treated as an error. If the browser reports the subscription
 * is gone (410/404), it's cleared from the donor record so future waves
 * don't keep trying to reach a dead endpoint.
 */
async function sendPushToDonor(donor, payload, options = {}) {
  if (!ensureConfigured()) return { sent: false, reason: 'push-not-configured' };

  if (!donor.pushSubscription) {
    return { sent: false, reason: 'no-subscription' };
  }

  try {
    // urgency 'high' wakes sleeping phones promptly; TTL drops stale alerts.
    await webpush.sendNotification(donor.pushSubscription, JSON.stringify(payload), {
      TTL: 60 * 60,
      urgency: 'high',
      ...options
    });
    return { sent: true };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await Donor.findByIdAndUpdate(donor._id, { pushSubscription: null });
      return { sent: false, reason: 'subscription-expired' };
    }
    console.error(`Push failed for donor ${donor.donorId || donor._id}:`, err.message);
    return { sent: false, reason: 'send-error' };
  }
}

async function notifyDonorsOfRequest(donors, request) {
  const payload = {
    type: 'new-request',
    tag: `request-${request._id}`,
    title:
      request.type === 'direct-need'
        ? `🩸 Someone near you needs ${request.bloodGroup} blood`
        : '🩸 Someone near you needs a replacement blood donor',
    body: `${request.hospital.name}, ${request.hospital.area}. Tap to view and accept or decline.`,
    requestId: request._id.toString()
  };

  return Promise.all(donors.map((d) => sendPushToDonor(d, payload)));
}

async function notifyRequestFilled(donorIds, requestId) {
  const donors = await Donor.find({ _id: { $in: donorIds } });
  const payload = {
    type: 'closed',
    tag: `request-${requestId}`,
    title: 'Request already filled',
    body: 'Thanks for being ready. Another donor already accepted this one.',
    requestId: requestId.toString()
  };
  await Promise.all(donors.map((d) => sendPushToDonor(d, payload, { TTL: 300 })));
}

// Sent when the requester cancels. Replaces the original alert (same tag) so a
// donor who hasn't opened it yet doesn't rush off for nothing.
async function notifyRequestCancelled(donorIds, requestId, { acceptedDonorId } = {}) {
  const donors = await Donor.find({ _id: { $in: donorIds } });
  await Promise.all(
    donors.map((d) => {
      const wasAccepted = acceptedDonorId && String(d._id) === String(acceptedDonorId);
      return sendPushToDonor(
        d,
        {
          type: 'closed',
          tag: `request-${requestId}`,
          title: wasAccepted ? 'Request cancelled: no need to travel' : 'Request cancelled',
          body: wasAccepted
            ? 'The requester cancelled this request. Thank you for being willing to help.'
            : 'The requester no longer needs a donor for this request.',
          requestId: requestId.toString()
        },
        { TTL: 300 }
      );
    })
  );
}

module.exports = {
  sendPushToDonor,
  notifyDonorsOfRequest,
  notifyRequestFilled,
  notifyRequestCancelled
};
