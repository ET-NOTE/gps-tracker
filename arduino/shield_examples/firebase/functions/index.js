"use strict";
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { makeHandler, sampleDecision } = require("./handler");
initializeApp(); // Managed credentials on Firebase; no downloaded service-account key.
const deviceKey = defineSecret("SHIELD_INGEST_KEY");
const DEVICE_ID = "YOUR_FIREBASE_DEVICE_ID"; // Match config.h; e.g. my-shield-01. One device for this tutorial.

exports.shieldIngest = onRequest({
  region: "asia-northeast3", timeoutSeconds: 30, memory: "256MiB",
  minInstances: 0, maxInstances: 1, concurrency: 4,
  invoker: "public", cors: false, secrets: [deviceKey],
}, makeHandler({
  getKey: () => deviceKey.value(), deviceId: DEVICE_ID,
  store: async (sample) => {
    const db = getFirestore();
    const ref = db.collection("shieldDevices").doc(DEVICE_ID).collection("latest").doc("sample");
    return db.runTransaction(async (tx) => {
      const previous = (await tx.get(ref)).data();
      const status = sampleDecision(previous, sample);
      // Identical retransmissions are acknowledged without a second write.
      if (status === 200 && previous?.at !== sample.at) tx.set(ref, sample);
      return status;
    });
  },
}));
