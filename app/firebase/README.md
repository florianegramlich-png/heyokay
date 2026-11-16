# Firebase config (Crashlytics)

Put the two files from the Firebase console here:

- `GoogleService-Info.plist` (iOS app `de.heyokay.app`)
- `google-services.json` (Android app `de.heyokay.app`)

`app.config.ts` turns on the Firebase and Crashlytics config plugins only when **both** files exist.
Without them, builds still work and crash reporting is a no-op.

These files contain project identifiers, not secrets, but keep them out of public forks.
Then make a new development build (`eas build --profile development`); Expo Go never includes Firebase.

Collection is off by default (`firebase.json` → `crashlytics_auto_collection_enabled: false`).
The app turns it on only when the user enables "Absturzberichte senden" in Settings.
