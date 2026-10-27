// Run once: node scripts/generateVapidKeys.js
// Copy the printed keys into your .env file.
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();
console.log('Add these to your .env:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('\nThe public key also needs to go into the frontend, used when the browser');
console.log('calls PushManager.subscribe() to register a donor for push notifications.');
