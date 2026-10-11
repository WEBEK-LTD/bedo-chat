import { getPushConfig, removePushSubscription, savePushSubscription } from '@bedo/api-client';
import { appEnablePush, appPushStatus, inIphoneApp } from './native-app';
/**
 * Web Push for this browser (D-21): login alerts and account notices reach the user's other web
 * sessions. On iPhone and iPad, push works only after the app is added to the Home Screen (iOS 16.4+).
 */
export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const SW_URL = '/sw.js';
/** D-53: in the iPhone app, "turned off in Settings → Notifications" is remembered here (iOS permission stays). */
const APP_OFF_KEY = 'bedo-app-push-off';

function appTurnedOff(): boolean {
  try {
    return localStorage.getItem(APP_OFF_KEY) === '1';
  } catch {
    return false;
  }
}

function setAppTurnedOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(APP_OFF_KEY, '1');
    else localStorage.removeItem(APP_OFF_KEY);
  } catch {
    // Storage unavailable: the choice lasts until the app is closed.
  }
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
    return app.permission === 'granted' && app.endpoint && !appTurnedOff() ? 'on' : 'off';
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
    setAppTurnedOff(false);
    return 'on';
  }
  if (!supported()) return 'unsupported';
  const key = await vapidKey();
  if (!key) return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.register(SW_URL);
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(key) }));
  await save(subscription);
  return 'on';
}

/** After sign-in: if this browser already allows notifications, link its subscription to the new session. */
export async function resumePush(): Promise<void> {
  if (inIphoneApp()) {
    // On every start: Apple may have given the app a new address. The first start asks for permission once.
    if (appTurnedOff()) return;
    const app = await appPushStatus();
    if (app.permission === 'denied') return;
    const ready = app.permission === 'granted' && app.endpoint ? app : await appEnablePush();
    if (ready.permission === 'granted' && ready.endpoint) await saveAppEndpoint(ready.endpoint);
    return;
  }
  if (!supported() || Notification.permission !== 'granted') return;
  const subscription = await existingSubscription();
  if (subscription) {
    await save(subscription);
  }
}

export async function disablePush(): Promise<PushState> {
  await removePushSubscription();
  if (inIphoneApp()) setAppTurnedOff(true);
  await unsubscribeThisBrowser();
  return 'off';
}

export async function unsubscribeThisBrowser(): Promise<void> {
  if (!supported()) return;
  const subscription = await existingSubscription();
  await subscription?.unsubscribe();
}
