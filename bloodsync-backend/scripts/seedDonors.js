// Run: npm run seed          (adds the 5000 donors)
//      npm run seed -- --reset  (removes any previously-seeded donors first, then re-adds them)
//
// Reads data/donors.csv (the same dataset delivered earlier as
// bloodsync_donors_5000.xlsx / .csv) and inserts it into MongoDB using the
// real Donor schema: mapping column names, converting Yes/No text to
// booleans, and assigning each donor a geographic coordinate near their
// city's center (with a small random spread) since the spreadsheet only
// has a city name, not coordinates.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const connectDB = require('../config/db');
const Donor = require('../models/Donor');
const { Counter } = require('../models/Counter');

const CSV_PATH = path.join(__dirname, '..', 'data', 'donors.csv');
const RESET = process.argv.includes('--reset');

// Same approximate city centers used by the frontend's tracking map, so
// seeded donors line up with the demo. Falls back to Karachi if a city
// in the sheet doesn't match anything here.
const cityCoords = {
  "karachi": [67.0011, 24.8607], "lahore": [74.3436, 31.5497], "islamabad": [73.0479, 33.6844],
  "rawalpindi": [73.0169, 33.5651], "faisalabad": [73.0791, 31.4187], "multan": [71.5249, 30.1575],
  "peshawar": [71.5249, 34.0151], "quetta": [66.9750, 30.1798], "sialkot": [74.5229, 32.4945],
  "gujranwala": [74.1945, 32.1877], "bahawalpur": [71.6836, 29.3956], "sargodha": [72.6711, 32.0836],
  "sukkur": [68.8574, 27.7052], "larkana": [68.2123, 27.5590], "sheikhupura": [73.9783, 31.7130],
  "jhang": [72.3181, 31.2781], "rahim yar khan": [70.2989, 28.4212], "gujrat": [74.0789, 32.5740],
  "kasur": [74.4502, 31.1156], "mardan": [72.0404, 34.1989], "mingora": [72.3604, 34.7717],
  "dera ghazi khan": [70.6345, 30.0561], "sahiwal": [73.1114, 30.6682], "nawabshah": [68.4100, 26.2442],
  "okara": [73.4534, 30.8081], "mirpur khas": [69.0113, 25.5268], "chiniot": [72.9770, 31.7202],
  "kamoke": [74.2225, 31.9756], "hafizabad": [73.6889, 32.0714], "kohat": [71.4400, 33.5900],
  "jacobabad": [68.4373, 28.2818], "shikarpur": [68.6383, 27.9558], "muzaffargarh": [71.1913, 30.0725],
  "khanpur": [70.6567, 28.6453], "gojra": [72.6849, 31.1497], "mandi bahauddin": [73.4913, 32.5859],
  "abbottabad": [73.2117, 34.1463], "turbat": [63.0434, 26.0034], "dera ismail khan": [70.9019, 31.8314],
  "chaman": [66.4491, 30.9214], "kot addu": [70.9646, 30.4675], "jaranwala": [73.4133, 31.3336],
  "muridke": [74.2649, 31.8028], "pakpattan": [73.3900, 30.3400], "vehari": [72.3500, 30.0333],
  "jhelum": [73.7257, 32.9425], "sadiqabad": [70.1290, 28.3078], "kabirwala": [71.8639, 30.4056],
  "khanewal": [71.9319, 30.3013], "toba tek singh": [72.4800, 30.9700], "wazirabad": [74.1250, 32.4425],
  "attock": [72.3639, 33.7666], "bahawalnagar": [73.2578, 29.9989], "mianwali": [71.5470, 32.5850],
  "layyah": [70.9428, 30.9693], "bhakkar": [71.0653, 31.6244], "chishtian": [72.8608, 29.7964],
  "nowshera": [71.9747, 34.0150], "swabi": [72.4700, 34.1200], "muzaffarabad": [73.4711, 34.3700]
};

function resolveCoords(cityName) {
  const key = (cityName || '').toLowerCase().trim();
  const base = cityCoords[key] || cityCoords['karachi'];
  // Spread donors within roughly 3km of the city center so they aren't
  // all stacked on one exact point, meaningful for $geoNear queries.
  const distKm = Math.random() * 3;
  const angle = Math.random() * Math.PI * 2;
  const dLat = (distKm / 111) * Math.cos(angle);
  const dLng = (distKm / (111 * Math.cos((base[1] * Math.PI) / 180))) * Math.sin(angle);
  return [base[0] + dLng, base[1] + dLat]; // [lng, lat]
}

function yesNoToBool(value) {
  return String(value).trim().toLowerCase() === 'yes';
}

function mapWillingFor(value) {
  return String(value).toLowerCase().includes('replacement') ? 'replacement-only' : 'any';
}

function mapRow(row) {
  const rawDate = (row['Last Donation Date'] || '').trim();
  const isFirstTime = !rawDate || rawDate.toLowerCase() === 'first-time donor';
  const lastDonationDate = isFirstTime ? null : new Date(rawDate);

  let status = 'active';
  let cooldownUntil = null;
  if (lastDonationDate) {
    const cooldownEnd = new Date(lastDonationDate);
    cooldownEnd.setDate(cooldownEnd.getDate() + 90);
    if (cooldownEnd > new Date()) {
      status = 'cooldown';
      cooldownUntil = cooldownEnd;
    }
  }

  return {
    donorId: row['Donor ID'],
    name: row['Name'],
    age: Number(row['Age']),
    gender: row['Gender'],
    cnic: row['CNIC'],
    weightKg: Number(row['Weight (kg)']),
    bloodGroup: row['Blood Group'],
    phone: row['Phone Number'],
    city: row['City'],
    address: row['Address'],
    location: { type: 'Point', coordinates: resolveCoords(row['City']) },
    eligibility: {
      chronicIllness: row['Chronic Illness'] || 'None',
      onMedication: yesNoToBool(row['Currently on Medication']),
      recentSurgeryTattooPiercing: yesNoToBool(row['Recent Surgery/Tattoo/Piercing (6mo)']),
      recentTravel: yesNoToBool(row['Recent Travel to Malaria/Disease-Endemic Area']),
      recentVaccination: yesNoToBool(row['Recent Vaccination']),
      pregnantOrBreastfeeding: false,
      alcoholDrugUse48h: yesNoToBool(row['Alcohol/Drug Use (24-48h)'])
    },
    willingFor: mapWillingFor(row['Willing to Donate For']),
    status,
    lastDonationDate,
    cooldownUntil
  };
}

async function seed() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Dataset not found at ${CSV_PATH}. Copy bloodsync_donors_5000.csv into data/ first.`);
  }

  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  console.log(`Parsed ${rows.length} rows from CSV`);

  const donors = rows.map(mapRow);
  const donorIds = donors.map((d) => d.donorId);

  await connectDB();

  if (RESET) {
    const { deletedCount } = await Donor.deleteMany({ donorId: { $in: donorIds } });
    console.log(`--reset: removed ${deletedCount} previously-seeded donors`);
  }

  const existing = await Donor.countDocuments({ donorId: { $in: donorIds } });
  if (existing > 0 && !RESET) {
    console.log(
      `${existing} of these donors already exist in the database. Run with --reset to wipe and re-seed, or clear the collection manually.`
    );
    process.exit(1);
  }

  const BATCH_SIZE = 500;
  let inserted = 0;
  for (let i = 0; i < donors.length; i += BATCH_SIZE) {
    const batch = donors.slice(i, i + BATCH_SIZE);
    await Donor.insertMany(batch, { ordered: false });
    inserted += batch.length;
    console.log(`Inserted ${inserted}/${donors.length}`);
  }

  // Keep the donorId auto-increment counter in sync so the next organically
  // registered donor continues from BS-05001 instead of colliding with seed data.
  const maxSeq = Math.max(
    ...donorIds.map((id) => parseInt(id.replace('BS-', ''), 10)).filter((n) => !Number.isNaN(n))
  );
  await Counter.findByIdAndUpdate('donorId', { seq: maxSeq }, { upsert: true });
  console.log(`Counter for donorId set to ${maxSeq}`);

  console.log('Done.');
  process.exit(0);
}

module.exports = { mapRow, resolveCoords, yesNoToBool, mapWillingFor };

if (require.main === module) {
  seed().catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  });
}
