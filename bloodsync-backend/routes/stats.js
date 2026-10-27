const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { getStats } = require('../controllers/statsController');
const { getReach } = require('../controllers/reachController');

const router = express.Router();
router.get('/stats', asyncHandler(getStats));
router.get('/reach', asyncHandler(getReach));
module.exports = router;
