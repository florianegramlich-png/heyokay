// Firebase native code is only linked once both Firebase config files exist in ./firebase
// (same rule as app.config.ts). Without this, iOS `pod install` fails: React Native Firebase
// requires dynamic frameworks, which app.config.ts only turns on together with Firebase.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const firebaseConfigured =
  existsSync(join(__dirname, 'firebase/GoogleService-Info.plist')) &&
  existsSync(join(__dirname, 'firebase/google-services.json'));

const unlinked = { platforms: { ios: null, android: null } };

module.exports = {
  dependencies: firebaseConfigured
    ? {}
    : {
        '@react-native-firebase/app': unlinked,
        '@react-native-firebase/crashlytics': unlinked,
      },
};
