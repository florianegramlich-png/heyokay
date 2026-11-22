'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n, type Key } from '@/lib/i18n';
import { buttonsToShow, makeNonce, NO_PROVIDERS, providerErrorKey, type Providers } from '@/lib/signin';
import type { SavedPlace, UserPrefs } from '@/lib/types';

/**
 * "Sign in with Apple" and "Sign in with Google" in the browser (PRD 5.3), with Apple's and
 * Google's own JavaScript (Sign in with Apple JS, Google Identity Services). A button shows only
 * when the server has that provider on and this site has its id:
 * NEXT_PUBLIC_APPLE_SERVICE_ID (+ NEXT_PUBLIC_APPLE_REDIRECT_URI, default: this page) and
 * NEXT_PUBLIC_GOOGLE_CLIENT_ID. Until Flori sets them, nothing changes on the page.
 */
const APPLE_ID = process.env.NEXT_PUBLIC_APPLE_SERVICE_ID || '';
const GOOGLE_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
const APPLE_JS = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const GOOGLE_JS = 'https://accounts.google.com/gsi/client';

type AppleJs = { auth: { init(o: Record<string, unknown>): void } };
type GoogleJs = { accounts: { id: {
  initialize(o: Record<string, unknown>): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
} } };
declare global { interface Window { AppleID?: AppleJs; google?: GoogleJs } }

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sha256Hex = async (s: string) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const had = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (had?.dataset.loaded) return resolve();
    const el = had ?? Object.assign(document.createElement('script'), { src, async: true });
    el.addEventListener('load', () => { el.dataset.loaded = '1'; resolve(); }, { once: true });
    el.addEventListener('error', () => reject(new Error(`could not load ${src}`)), { once: true });
    if (!had) document.head.appendChild(el);
  });
}

export function ProviderButtons({ onSignedIn }: {
  onSignedIn: (next: { email: string; prefs: UserPrefs; places: SavedPlace[] }) => void;
}) {
  const { t, lang } = useI18n();
  const [providers, setProviders] = useState<Providers>(NO_PROVIDERS);
  const [error, setError] = useState<Key | null>(null);
  const googleEl = useRef<HTMLDivElement>(null);
  const buttons = buttonsToShow(providers, { apple: !!APPLE_ID, google: !!GOOGLE_ID });

  useEffect(() => { api.authProviders().then(setProviders).catch(() => {}); }, []);

  const finish = async (provider: 'apple' | 'google', idToken: string, raw: string) => {
    try {
      const r = await api.signInWith(provider, idToken, raw);
      onSignedIn({ email: r.account.email, prefs: r.prefs, places: r.places });
    } catch (e) {
      setError(e instanceof ApiError ? providerErrorKey(e.status, e.message) : 'acc.err.generic');
    }
  };

  // Google draws its own button; each attempt gets a fresh nonce (set again after every sign-in).
  useEffect(() => {
    if (!buttons.includes('google') || !googleEl.current) return;
    let live = true;
    const setup = async () => {
      await loadScript(GOOGLE_JS);
      const nonce = await makeNonce(random, sha256Hex);
      if (!live || !window.google || !googleEl.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_ID, nonce: nonce.hashed, auto_select: false, cancel_on_tap_outside: true,
        callback: async (resp: { credential?: string }) => {
          setError(null);
          if (resp.credential) await finish('google', resp.credential, nonce.raw); else setError('acc.err.provider');
          void setup();
        },
      });
      window.google.accounts.id.renderButton(googleEl.current, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', width: 320, locale: lang });
    };
    setup().catch(() => setError('acc.err.providerOff'));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttons.join(), lang]);

  // Apple draws its own button into #appleid-signin; with a popup it reports by DOM events.
  useEffect(() => {
    if (!buttons.includes('apple')) return;
    let raw = '';
    const ok = (ev: Event) => {
      const idToken = (ev as CustomEvent<{ authorization?: { id_token?: string } }>).detail?.authorization?.id_token;
      setError(null);
      if (idToken) void finish('apple', idToken, raw).finally(() => { void setup(); }); else setError('acc.err.provider');
    };
    const failed = (ev: Event) => {
      // Closing Apple's window reports "popup_closed_by_user": nothing to say.
      if ((ev as CustomEvent<{ error?: string }>).detail?.error !== 'popup_closed_by_user') setError('acc.err.provider');
      void setup();
    };
    const setup = async () => {
      await loadScript(APPLE_JS);
      const nonce = await makeNonce(random, sha256Hex);
      raw = nonce.raw;
      window.AppleID!.auth.init({
        clientId: APPLE_ID, scope: 'email', usePopup: true, nonce: nonce.hashed,
        redirectURI: process.env.NEXT_PUBLIC_APPLE_REDIRECT_URI || `${window.location.origin}/settings`,
      });
    };
    document.addEventListener('AppleIDSignInOnSuccess', ok);
    document.addEventListener('AppleIDSignInOnFailure', failed);
    setup().catch(() => setError('acc.err.providerOff'));
    return () => {
      document.removeEventListener('AppleIDSignInOnSuccess', ok);
      document.removeEventListener('AppleIDSignInOnFailure', failed);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttons.join()]);

  if (!buttons.length) return null;
  return (
    <div className="space-y-2">
      {buttons.includes('apple') && (
        <div id="appleid-signin" className="mx-auto h-11 w-80 max-w-full cursor-pointer" data-color="white" data-border="false" data-type="sign-in" data-mode="center-align" data-border-radius="50" aria-label={t('acc.apple')} />
      )}
      {buttons.includes('google') && <div ref={googleEl} className="flex justify-center" />}
      {error && <p role="alert" className="text-sm text-orange-300">{t(error)}</p>}
      <p className="text-sm text-muted-foreground">{t('acc.or')}</p>
    </div>
  );
}
