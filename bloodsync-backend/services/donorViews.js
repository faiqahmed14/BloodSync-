// What a donor (or anyone holding their id) may see about a donor record.
// The CNIC and the push subscription are never sent back to a browser.
function donorSelf(doc) {
  const d = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete d.cnic;
  delete d.pushSubscription;
  delete d.__v;
  return d;
}

module.exports = { donorSelf };
