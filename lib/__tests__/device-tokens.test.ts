import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';

import { api } from '../api-client';
import {
  ensurePushPermission,
  providerForPlatform,
  registerDeviceForPush,
  UnsupportedDeviceError,
} from '../device-tokens';

// A plain `{ isDevice: true }` mock gets value-copied by Babel's
// `_interopRequireWildcard` on `import * as Device`, so mutating it from a
// test wouldn't be visible to device-tokens.ts's own copy. A real
// getter/setter descriptor is preserved by that interop instead of copied,
// so both files see the same underlying flag.
jest.mock('expo-device', () => {
  let isDevice = true;
  return {
    get isDevice() {
      return isDevice;
    },
    set isDevice(value: boolean) {
      isDevice = value;
    },
  };
});

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
  IosAuthorizationStatus: { PROVISIONAL: 3 },
}));

jest.mock('../api-client', () => ({
  api: { registerDeviceToken: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  (Device as { isDevice: boolean }).isDevice = true;
});

describe('providerForPlatform', () => {
  it('maps ios to apns', () => {
    expect(providerForPlatform('ios')).toBe('apns');
  });

  it('maps android to fcm', () => {
    expect(providerForPlatform('android')).toBe('fcm');
  });
});

describe('ensurePushPermission', () => {
  it('returns false on a simulator/emulator without asking', async () => {
    (Device as { isDevice: boolean }).isDevice = false;
    const result = await ensurePushPermission();
    expect(result).toBe(false);
    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  });

  it('short-circuits true when already granted', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    const result = await ensurePushPermission();
    expect(result).toBe(true);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('treats iOS provisional authorization as granted', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
      granted: false,
      ios: { status: IosAuthorizationStatus.PROVISIONAL },
    });
    const result = await ensurePushPermission();
    expect(result).toBe(true);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requests permission when not already granted', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    const result = await ensurePushPermission();
    expect(result).toBe(true);
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
  });

  it('returns false when the user denies the request', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    const result = await ensurePushPermission();
    expect(result).toBe(false);
  });
});

describe('registerDeviceForPush', () => {
  it('registers an Android FCM token', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (Notifications.getDevicePushTokenAsync as jest.Mock).mockResolvedValue({
      type: 'android',
      data: 'fcm-token-abc',
    });
    (api.registerDeviceToken as jest.Mock).mockResolvedValue({ id: 'dt-1' });

    const result = await registerDeviceForPush();

    expect(api.registerDeviceToken).toHaveBeenCalledWith({
      provider: 'fcm',
      platform: 'android',
      token: 'fcm-token-abc',
    });
    expect(result).toEqual({ id: 'dt-1' });
  });

  it('registers an iOS APNs token', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (Notifications.getDevicePushTokenAsync as jest.Mock).mockResolvedValue({
      type: 'ios',
      data: 'apns-token-abc',
    });
    (api.registerDeviceToken as jest.Mock).mockResolvedValue({ id: 'dt-2' });

    await registerDeviceForPush();

    expect(api.registerDeviceToken).toHaveBeenCalledWith({
      provider: 'apns',
      platform: 'ios',
      token: 'apns-token-abc',
    });
  });

  it('returns null without fetching a token when permission is denied', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

    const result = await registerDeviceForPush();

    expect(result).toBeNull();
    expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(api.registerDeviceToken).not.toHaveBeenCalled();
  });

  it('throws UnsupportedDeviceError for a web push token', async () => {
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    (Notifications.getDevicePushTokenAsync as jest.Mock).mockResolvedValue({
      type: 'web',
      data: { endpoint: 'https://example.com', keys: { p256dh: 'x', auth: 'y' } },
    });

    await expect(registerDeviceForPush()).rejects.toBeInstanceOf(UnsupportedDeviceError);
    expect(api.registerDeviceToken).not.toHaveBeenCalled();
  });
});
