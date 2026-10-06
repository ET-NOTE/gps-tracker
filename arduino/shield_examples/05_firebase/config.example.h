#pragma once
#define SHIELD_APN "iot.1nce.net" // Included for 1NCE; no Shield account setup required.
// Use the exact HTTPS Function URL returned by Firebase deploy, split into host + path.
#define FIREBASE_HOST "YOUR_FUNCTION_HOST"
#define FIREBASE_PATH "/shieldIngest" // For a run.app root URL this may be "/".
#define FIREBASE_DEVICE_ID "YOUR_FIREBASE_DEVICE_ID"
#define FIREBASE_DEVICE_KEY "YOUR_NEW_64_LOWERCASE_HEX_KEY" // A new secret for YOUR Firebase project only; not a Shield registration code.
#define FIREBASE_CA "firebase-example-ca.pem"
#define DHT_DATA_PIN 2
#define SEND_INTERVAL_MS 60000UL
