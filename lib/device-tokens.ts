import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';

import { api } from './api-client';
import type { DeviceToken, DeviceTokenProvider, DevicePlatform } from './api-types';

// ADR-0007: Android always registers via FCM, iOS always via APNs directly
// (the backend speaks both providers' wire protocols itself, with no
// Firebase/vendor SDK) — "provider" tracks which one issued the token,
// "platform" is recorded for operator visibility only.
export function providerForPlatform(platform: DevicePlatform): DeviceTokenProvider {
  return platform === 'ios' ? 'apns' : 'fcm';
}

export async function ensurePushPermission(): Promise<boolean> {
  if (!Device.isDevice) {
    // Simulators/emulators have no push token to hand the backend.
    return false;
  }
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  if (existing.ios?.status === IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }
  const requested = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return requested.granted;
}

export class UnsupportedDeviceError extends Error {
  constructor() {
    super('This device push token type is not supported by the pulsewatch backend.');
    this.name = 'UnsupportedDeviceError';
  }
}

/**
 * Requests permission if needed, fetches the raw native device token
 * (FCM token on Android, APNs token on iOS — never an Expo push token,
 * since the backend speaks the providers' wire protocols directly), and
 * upserts it with the server. Returns null if permission was denied or
 * this isn't a real device.
 */
export async function registerDeviceForPush(): Promise<DeviceToken | null> {
  const granted = await ensurePushPermission();
  if (!granted) return null;

  const devicePushToken = await Notifications.getDevicePushTokenAsync();
  if (devicePushToken.type !== 'ios' && devicePushToken.type !== 'android') {
    throw new UnsupportedDeviceError();
  }

  const platform: DevicePlatform = devicePushToken.type;
  return api.registerDeviceToken({
    provider: providerForPlatform(platform),
    platform,
    token: String(devicePushToken.data),
  });
}
