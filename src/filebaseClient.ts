import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(
      require('fs').readFileSync(
        "firebase/terra-rex-82a58-firebase-adminsdk-fbsvc-3aa42b9281.json",
        'utf8'
      )
    )
  ),
});

export default admin;