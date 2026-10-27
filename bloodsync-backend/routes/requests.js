const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const {
  createRequest,
  getRequest,
  acceptRequest,
  declineRequest,
  startTransit,
  updateLocation,
  completeRequest,
  cancelRequest
} = require('../controllers/requestController');

const router = express.Router();

router.post('/', asyncHandler(createRequest));
router.get('/:id', asyncHandler(getRequest));
router.patch('/:id/accept', asyncHandler(acceptRequest));
router.patch('/:id/decline', asyncHandler(declineRequest));
router.patch('/:id/start-transit', asyncHandler(startTransit));
router.patch('/:id/location', asyncHandler(updateLocation));
router.patch('/:id/complete', asyncHandler(completeRequest));
router.patch('/:id/cancel', asyncHandler(cancelRequest));

module.exports = router;
