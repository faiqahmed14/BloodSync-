const mongoose = require('mongoose');
const { getNextSequence } = require('./Counter');

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const donorSchema = new mongoose.Schema(
  {
    donorId: { type: String, unique: true }, // e.g. "BS-00001", auto-generated
    name: { type: String, required: true, trim: true },
    age: { type: Number, required: true, min: 18, max: 65 },
    gender: { type: String, enum: ['Male', 'Female', 'Prefer not to say'], required: true },
    cnic: { type: String, required: true, trim: true },
    weightKg: { type: Number, required: true, min: 50 },
    bloodGroup: { type: String, enum: BLOOD_GROUPS, required: true },
    phone: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },

    // GeoJSON point: required for $geoNear / $near proximity queries
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    },

    eligibility: {
      chronicIllness: { type: String, default: 'None' },
      onMedication: { type: Boolean, default: false },
      recentSurgeryTattooPiercing: { type: Boolean, default: false },
      recentTravel: { type: Boolean, default: false },
      recentVaccination: { type: Boolean, default: false },
      pregnantOrBreastfeeding: { type: Boolean, default: false },
      alcoholDrugUse48h: { type: Boolean, default: false }
    },

    willingFor: { type: String, enum: ['any', 'replacement-only'], default: 'any' },
    status: { type: String, enum: ['active', 'cooldown', 'inactive'], default: 'active' },

    lastDonationDate: { type: Date, default: null },
    // Number of completed donations made through BloodSync (drives the donor level badges).
    donationCount: { type: Number, default: 0, min: 0 },
    cooldownUntil: { type: Date, default: null },

    pushSubscription: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

// Geospatial index: powers "nearest donors" queries
donorSchema.index({ location: '2dsphere' });
// Speeds up the matching engine's core filter
donorSchema.index({ bloodGroup: 1, city: 1, status: 1 });

donorSchema.pre('save', async function () {
  if (this.isNew && !this.donorId) {
    const seq = await getNextSequence('donorId');
    this.donorId = `BS-${String(seq).padStart(5, '0')}`;
  }
});

// If a donor's cooldown has lapsed, flip them back to active automatically
donorSchema.methods.refreshStatusIfCooldownExpired = function () {
  if (this.status === 'cooldown' && this.cooldownUntil && this.cooldownUntil <= new Date()) {
    this.status = 'active';
    this.cooldownUntil = null;
  }
  return this;
};

module.exports = mongoose.model('Donor', donorSchema);
module.exports.BLOOD_GROUPS = BLOOD_GROUPS;
