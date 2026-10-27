const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { getBoard } = require('../controllers/boardController');

const router = express.Router();

router.get('/', asyncHandler(getBoard));

module.exports = router;
