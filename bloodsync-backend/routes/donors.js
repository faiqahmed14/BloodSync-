const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const {
  createDonor,
  getDonor,
  listDonors,
  updateDonor,
  savePushSubscription,
  getMyNotifications,
  getActiveRequest
} = require('../controllers/donorController');

const router = express.Router();

router.post('/', asyncHandler(createDonor));
router.get('/', asyncHandler(listDonors));
router.get('/:id', asyncHandler(getDonor));
router.get('/:id/notifications', asyncHandler(getMyNotifications));
router.get('/:id/active-request', asyncHandler(getActiveRequest));
router.patch('/:id', asyncHandler(updateDonor));
router.post('/:id/push-subscription', asyncHandler(savePushSubscription));

module.exports = router;
