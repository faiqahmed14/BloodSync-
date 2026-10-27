const mongoose = require('mongoose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Turns the cryptic driver errors people actually hit when deploying into one plain sentence.
function explain(err) {
  const m = String(err && err.message);
  if (/bad auth|Authentication failed/i.test(m)) {
    return 'MongoDB rejected the username or password in MONGODB_URI. If your password contains characters like @ : / ? # % it must be URL-encoded (for example @ becomes %40).';
  }
  if (/ENOTFOUND|querySrv|getaddrinfo/i.test(m)) {
    return 'The cluster address in MONGODB_URI could not be found. Copy the connection string again from Atlas (Connect > Drivers).';
  }
  if (/Invalid scheme|Invalid connection string|must be in the following format/i.test(m)) {
    return 'MONGODB_URI is not a valid MongoDB connection string. It should start with mongodb+srv:// or mongodb://';
  }
  if (/ServerSelection|timed out|ECONNREFUSED|whitelist|IP/i.test(m)) {
    return 'MongoDB could not be reached. On Atlas open Network Access and allow the server\'s address. Hosting platforms use changing addresses, so use 0.0.0.0/0 (Allow access from anywhere).';
  }
  return null;
}

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Add it to .env locally, or to the Environment settings of your hosting service.');
  }

  const attempts = Number(process.env.DB_CONNECT_ATTEMPTS) || 4;
  for (let i = 1; i <= attempts; i++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      break;
    } catch (err) {
      const hint = explain(err);
      const fatal = /bad auth|Authentication failed|Invalid scheme|Invalid connection string/i.test(err.message);
      if (i === attempts || fatal) { err.hint = hint; throw err; }
      console.warn(`MongoDB connection attempt ${i}/${attempts} failed (${err.message}). Retrying in 5 s...`);
      await sleep(5000);
    }
  }
  console.log('MongoDB connected');

  // Build the indexes BEFORE serving traffic. The nearest-donor search ($geoNear) needs the 2dsphere
  // index, and on a brand-new database the very first request could otherwise arrive before it exists
  // and fail with "unable to find index for $geoNear query".
  await Promise.all([
    require('../models/Donor').init(),
    require('../models/Request').init(),
    require('../models/Notification').init()
  ]);

  mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected, the driver will keep trying to reconnect'));
  mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));
}

module.exports = connectDB;
module.exports.explain = explain;
