const { Server } = require('socket.io');

let io = null;

function initSockets(httpServer) {
  io = new Server(httpServer, {
    // Same allow-list as the REST API (CORS_ORIGINS). Unset = any origin.
    cors: { origin: require('../middleware/corsOrigins').corsOriginCheck }
  });

  io.on('connection', (socket) => {
    // The requester's tracking screen joins the room for the specific
    // request it cares about, so location/status updates only go to them.
    socket.on('request:join', (requestId) => {
      socket.join(`request:${requestId}`);
    });

    socket.on('request:leave', (requestId) => {
      socket.leave(`request:${requestId}`);
    });

    // Anyone watching the homepage board joins this shared room.
    socket.on('board:join', () => {
      socket.join('board');
    });

    // A registered donor's browser joins its own room so new requests can pop up
    // instantly and be withdrawn instantly when filled / cancelled.
    socket.on('donor:join', (donorId) => {
      if (donorId) socket.join(`donor:${donorId}`);
    });

    socket.on('donor:leave', (donorId) => {
      if (donorId) socket.leave(`donor:${donorId}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io has not been initialized yet. Call initSockets(server) first.');
  return io;
}

// ---- Emit helpers used by controllers ----

function emitBoardUpdate() {
  getIO().to('board').emit('board:update');
}

function emitRequestStatus(requestId, status, extra = {}) {
  getIO().to(`request:${requestId}`).emit('request:status', { status, ...extra });
}

function emitDonorLocation(requestId, coordinates, updatedAt = new Date()) {
  getIO().to(`request:${requestId}`).emit('request:location', { coordinates, updatedAt });
}

// Pop-up alert for one donor: a new request was just sent to them.
function emitDonorNewRequest(donorId, payload) {
  getIO().to(`donor:${donorId}`).emit('donor:request', payload);
}

// Tell donors a request is no longer open to them (filled by someone else, or
// cancelled by the requester). Payload never contains private details.
function emitDonorRequestClosed(donorIds, requestId, reason, extra = {}) {
  for (const id of donorIds) {
    getIO().to(`donor:${id}`).emit('donor:closed', { requestId: String(requestId), reason, ...extra });
  }
}

function emitRequestMatched(requestId, donor, etaMinutes) {
  getIO().to(`request:${requestId}`).emit('request:matched', {
    donor: {
      name: donor.name,
      bloodGroup: donor.bloodGroup,
      phone: donor.phone,
      donorId: donor.donorId
    },
    etaMinutes
  });
}

module.exports = {
  initSockets,
  getIO,
  emitBoardUpdate,
  emitRequestStatus,
  emitDonorLocation,
  emitRequestMatched,
  emitDonorNewRequest,
  emitDonorRequestClosed
};
