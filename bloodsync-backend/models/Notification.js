const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Request', required: true },
    donorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donor', required: true },
    wave: { type: Number, required: true },
    sentAt: { type: Date, default: Date.now },
    response: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'withdrawn'],
      default: 'pending'
    }
  },
  { timestamps: true }
);

notificationSchema.index({ requestId: 1, donorId: 1 }, { unique: true });

module.exports = mongoose.model('Notification', notificationSchema);
