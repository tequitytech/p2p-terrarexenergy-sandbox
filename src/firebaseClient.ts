import admin from "firebase-admin";
import fs from 'fs';

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
if (serviceAccountPath) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'))
      ),
    });
  } catch (error) {
    console.warn("[Firebase] Failed to initialize:", error);
  }
} else {
  console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_PATH not set — push notifications disabled');
}

export default admin;
