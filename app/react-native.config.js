// Firebase native code is only linked once both Firebase config files exist in ./firebase
// (same rule as app.config.ts). Without this, iOS `pod install` fails: React Native Firebase
// requires dynamic frameworks, which app.config.ts only turns on together with Firebase.
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const firebaseConfigured =
  existsSync(join(__dirname, 'firebase/GoogleService-Info.plist')) &&
  existsSync(join(__dirname, 'firebase/google-services.json'));

// Google sign-in native code is only linked when both client ids are set for the build
// (same rule as googleIdsFromEnv in src/lib/google-signin.ts, used by app.config.ts).
const googleId = (v) => /^[\w-]+\.apps\.googleusercontent\.com$/.test((v || '').trim());
const googleConfigured = googleId(process.env.GOOGLE_WEB_CLIENT_ID) && googleId(process.env.GOOGLE_IOS_CLIENT_ID);

const unlinked = { platforms: { ios: null, android: null } };

module.exports = {
  dependencies: {
    ...(firebaseConfigured ? {} : {
      '@react-native-firebase/app': unlinked,
      '@react-native-firebase/crashlytics': unlinked,
    }),
    ...(googleConfigured ? {} : {
      'react-native-nitro-google-signin': unlinked,
      'react-native-nitro-modules': unlinked,
    }),
  },
};
