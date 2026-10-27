// Controls exactly what each party is allowed to see about a request.
//
//  - donorPreview : what a donor sees BEFORE accepting (no names, no phone numbers)
//  - donorDetail  : what the donor who ACCEPTED sees (patient + contact details)
//  - requesterView: what the person who raised the request sees (never the secret
//                   token, never the list of donors who were asked)

function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
}

function coords(point) {
  return point && Array.isArray(point.coordinates) && point.coordinates.length === 2
    ? point.coordinates
    : null;
}

function donorPreview(request, distanceMeters) {
  const r = plain(request);
  return {
    _id: String(r._id),
    requestId: r.requestId,
    type: r.type,
    bloodGroup: r.bloodGroup,
    unitsRequired: r.unitsRequired,
    reason: r.reason,
    hospital: { name: r.hospital.name, area: r.hospital.area },
    patient: { age: r.patient.age, gender: r.patient.gender },
    location: coords(r.location),
    createdAt: r.createdAt,
    distanceKm:
      distanceMeters === undefined || distanceMeters === null
        ? null
        : Math.round(distanceMeters / 100) / 10
  };
}

function donorDetail(request) {
  const r = plain(request);
  return {
    _id: String(r._id),
    requestId: r.requestId,
    status: r.status,
    type: r.type,
    bloodGroup: r.bloodGroup,
    unitsRequired: r.unitsRequired,
    reason: r.reason,
    patient: { name: r.patient.name, age: r.patient.age, gender: r.patient.gender },
    hospital: { name: r.hospital.name, area: r.hospital.area },
    doctor: r.doctor && (r.doctor.name || r.doctor.contact) ? r.doctor : null,
    requester: { relationship: r.requester.relationship, contact: r.requester.contact },
    notes: r.notes || '',
    location: coords(r.location),
    locationSource: r.locationSource,
    acceptedAt: r.acceptedAt
  };
}

function requesterView(request) {
  const r = plain(request);
  delete r.notifiedDonorIds;
  delete r.requesterToken;
  delete r.__v;
  return r;
}

module.exports = { donorPreview, donorDetail, requesterView, coords };
