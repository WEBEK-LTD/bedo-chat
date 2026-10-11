import { getPushConfig, removePushSubscription, savePushSubscription } from '@bedo/api-client';
import { appEnablePush, appPushStatus, inIphoneApp } from './native-app';
/**
 * Web Push for this browser (D-21): login alerts and account notices reach the user's other web
 * sessions. On iPhone and iPad, push works only after the app is added to the Home Screen (iOS 16.4+).
 */
export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const SW_URL = '/sw.js';
/**
 * Turned off on this device in Settings → Notifications (D-55): remembered here so a start never turns them back on
 * by itself. (The phone or browser permission may stay "allowed".) The older iPhone-app key is still read.
 */
const OFF_KEY = 'bedo-push-off';
const OLD_APP_OFF_KEY = 'bedo-app-push-off';
/** D-55: "Not now" on the banner that offers notifications hides it on this device for a week. */
const SNOOZE_KEY = 'bedo-push-banner-snoozed-until';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
/** D-55: this tab was opened by the Android app (Trusted Web Activity), remembered for the tab's reloads. */
const ANDROID_APP_KEY = 'bedo-android-app';
const ANDROID_APP_REFERRER = 'android-app://com.bedochat.app';

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

/** Whether notifications were turned off on this device in Settings. */
export function pushTurnedOff(): boolean {
  const local = storage('local');
  return local?.getItem(OFF_KEY) === '1' || local?.getItem(OLD_APP_OFF_KEY) === '1';
}

function setTurnedOff(off: boolean): void {
  const local = storage('local');
  try {
    if (off) local?.setItem(OFF_KEY, '1');
    else {
      local?.removeItem(OFF_KEY);
      local?.removeItem(OLD_APP_OFF_KEY);
    }
  } catch {
    // Storage full or blocked: the choice lasts until the page is closed.
  }
}

/** Whether the banner offering notifications was put off ("Not now") less than a week ago. */
export function pushBannerSnoozed(): boolean {
  return Number(storage('local')?.getItem(SNOOZE_KEY) ?? 0) > Date.now();
}

export function snoozePushBanner(): void {
  try {
    storage('local')?.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  } catch {
    // Storage blocked: the banner comes back next time.
  }
}

/** D-55: whether this page runs in the Bedo Chat Android app (opened by it, in this tab). */
export function inAndroidApp(): boolean {
  if (typeof document === 'undefined') return false;
  const session = storage('session');
  if (document.referrer.startsWith(ANDROID_APP_REFERRER)) {
    try {
      session?.setItem(ANDROID_APP_KEY, '1');
    } catch {
      // Storage blocked: only this page load counts.
    }
    return true;
  }
  return session?.getItem(ANDROID_APP_KEY) === '1';
}

/** The iPhone app's device address, saved with this session like a browser's (D-53: no table changes). */
async function saveAppEndpoint(endpoint: string): Promise<void> {
  await savePushSubscription({ endpoint, keys: { p256dh: 'apns', auth: 'apns' } });
}

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

async function vapidKey(): Promise<string | null> {
  const config = await getPushConfig();
  return config.vapidPublicKey;
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SW_URL);
  return registration ? registration.pushManager.getSubscription() : null;
}

async function save(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  await savePushSubscription({ endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } });
}

export async function pushState(): Promise<PushState> {
  if (inIphoneApp()) {
    const app = await appPushStatus();
    if (app.permission === 'denied') return 'denied';
    return app.permission === 'granted' && app.endpoint && !pushTurnedOff() ? 'on' : 'off';
  }
  if (!supported()) return 'unsupported';
  if (!(await vapidKey())) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  return (await existingSubscription()) ? 'on' : 'off';
}

/** Asks for permission (must be called from a click) and registers this browser with this session. */
export async function enablePush(): Promise<PushState> {
  if (inIphoneApp()) {
    const app = await appEnablePush();
    if (app.permission !== 'granted') return app.permission === 'denied' ? 'denied' : 'off';
    if (!app.endpoint) return 'unavailable';
    await saveAppEndpoint(app.endpoint);
    setTurnedOff(false);
    return 'on';
  }
  if (!supported()) return 'unsupported';
  const key = await vapidKey();
  if (!key) return 'unavailable';
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  await subscribe(key);
  setTurnedOff(false);
  return 'on';
}

/** Registers this browser with the push service (permission already given) and links it to this session. */
async function subscribe(key: string): Promise<void> {
  const registration = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) }));
  await save(subscription);
}

/**
 * On every start once signed in (D-55), unless turned off on this device in Settings: where notifications are
 * allowed, this device is registered and linked to the session at once (no button to press); the apps ask for the
 * permission themselves the first time (the iPhone app, and the Android app on Android 13 and later). Answers the
 * resulting state, so the chat screen can offer the button where a browser still has to ask.
 */
export async function resumePush(): Promise<PushState> {
  if (inIphoneApp()) {
    // Apple may have given the app a new address. The first start asks for permission once.
    if (pushTurnedOff()) return 'off';
    const app = await appPushStatus();
    if (app.permission === 'denied') return 'denied';
    const ready = app.permission === 'granted' && app.endpoint ? app : await appEnablePush();
    if (ready.permission === 'granted' && ready.endpoint) {
      await saveAppEndpoint(ready.endpoint);
      return 'on';
    }
    return ready.permission === 'denied' ? 'denied' : 'off';
  }
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (pushTurnedOff()) return 'off';
  const key = await vapidKey();
  if (!key) return 'unavailable';
  if (Notification.permission === 'granted') {
    await subscribe(key);
    return 'on';
  }
  // The Android app hands the question to Android ("Allow Bedo Chat to send you notifications?"). A browser tab is
  // never asked without a click: the chat screen shows a button instead.
  if (inAndroidApp()) return enablePush().catch(() => 'off' as const);
  return 'off';
}

export async function disablePush(): Promise<PushState> {
  await removePushSubscription();
  setTurnedOff(true);
  await unsubscribeThisBrowser();
  return 'off';
}

export async function unsubscribeThisBrowser(): Promise<void> {
  if (!supported()) return;
  const subscription = await existingSubscription();
  await subscription?.unsubscribe();
}

// D-55: remember a start from the Android app before any client-side navigation.
if (typeof window !== 'undefined') inAndroidApp();
