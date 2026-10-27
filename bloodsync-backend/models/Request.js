const crypto = require('crypto');
const mongoose = require('mongoose');
const { getNextSequence } = require('./Counter');
const { BLOOD_GROUPS } = require('./Donor');

const requestSchema = new mongoose.Schema(
  {
    requestId: { type: String, unique: true }, // e.g. "REQ-00001", auto-generated

    type: { type: String, enum: ['direct-need', 'replacement'], required: true },

    patient: {
      name: { type: String, required: true },
      age: { type: Number, required: true },
      gender: { type: String, enum: ['Male', 'Female', 'Prefer not to say'], required: true }
    },

    // Ignored entirely by the matching engine when type === 'replacement'
    bloodGroup: { type: String, enum: BLOOD_GROUPS, required: true },
    unitsRequired: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },

    hospital: {
      name: { type: String, required: true },
      area: { type: String, required: true } // human-readable location/area
    },

    doctor: {
      name: { type: String },
      contact: { type: String }
    },

    requester: {
      relationship: { type: String, required: true },
      contact: { type: String, required: true }
    },

    // GeoJSON point at the hospital, the matching engine searches nearest donors to this
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    },

    status: {
      type: String,
      enum: ['searching', 'matched', 'in-transit', 'completed', 'cancelled', 'no-donors-available'],
      default: 'searching'
    },

    wave: { type: Number, default: 20 }, // 20 -> 50 -> 100 -> 200 -> keeps expanding
    waveStartedAt: { type: Date, default: Date.now },

    notifiedDonorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Donor' }],
    acceptedDonorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donor', default: null },

    // Last known live-tracking position of the accepted donor.
    // Deliberately has NO default: a request that nobody has accepted yet must not
    // carry a half-empty { type: 'Point' } object (no coordinates), clients that
    // tried to read coordinates from it used to crash on it.
    donorCurrentLocation: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
      updatedAt: { type: Date }
    },

    // How the request location was obtained: the requester's device GPS, a geocoded
    // hospital address, or just the centre of the typed city (least accurate).
    locationSource: { type: String, enum: ['gps', 'geocoded', 'city-fallback'], default: 'city-fallback' },

    acceptedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Cancellation ("Cancel My Request")
    cancelledAt: { type: Date, default: null },
    cancelReason: {
      type: String,
      enum: ['donor-not-found', 'arranged-locally', 'no-longer-needed', 'other'],
      default: undefined
    },
    cancelNote: { type: String, default: '' },

    // Secret handed ONLY to the browser that created the request. Needed to cancel
    // (or complete) it, so nobody else who learns the request id can do that.
    requesterToken: {
      type: String,
      select: false,
      default: () => crypto.randomBytes(16).toString('hex')
    },

    notes: { type: String, default: '' }
  },
  { timestamps: true }
);

requestSchema.index({ location: '2dsphere' });
requestSchema.index({ status: 1, bloodGroup: 1 });

requestSchema.pre('save', async function () {
  if (this.isNew && !this.requestId) {
    const seq = await getNextSequence('requestId');
    this.requestId = `REQ-${String(seq).padStart(5, '0')}`;
  }
});

module.exports = mongoose.model('Request', requestSchema);
