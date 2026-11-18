import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { session } from '../lib/session';
import { colors } from '../lib/theme';

export default function Index() {
  const [target, setTarget] = useState<'/feed' | '/onboarding' | null>(null);

  useEffect(() => {
    (async () => {
      const ok = (await session.isOnboarded()) && !!(await session.getToken());
      setTarget(ok ? '/feed' : '/onboarding');
    })();
  }, []);

  if (!target) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.cyan} />
      </View>
    );
  }
  return <Redirect href={target} />;
}
