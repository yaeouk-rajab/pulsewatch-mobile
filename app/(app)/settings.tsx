import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth-context';
import {
  useDeviceRegistrationStatus,
  type DeviceRegistrationStatus,
} from '../../lib/device-registration-status';
import { useAsync } from '../../lib/use-async';
import type { DeviceToken } from '../../lib/api-types';

function deviceStatusLabel(device: DeviceToken): string {
  if (device.revoked_at) return 'Signed out';
  if (device.dead_at) return `Unreachable (${device.dead_reason ?? 'unknown reason'})`;
  return 'Active';
}

// Only failures are worth an operator's attention; in-flight and success are
// already legible from the device list below.
function registrationFailureMessage(status: DeviceRegistrationStatus): string | null {
  if (status.state !== 'failed') return null;
  switch (status.reason) {
    case 'permission-denied':
      return "Notifications are turned off for PulseWatch on this device, so you won't receive alerts here. Enable them in your device settings, then reopen the app.";
    case 'unsupported-device':
      return "This device's push token type isn't supported by the PulseWatch server, so you won't receive alerts here.";
    case 'request-failed':
      return `Couldn't register this device for alerts${status.message ? ` (${status.message})` : ''}, so you won't receive them here. Check your connection and reopen the app to try again.`;
  }
}

// Same "only tell the operator what they need to act on" shape as
// registrationFailureMessage above: a thrown ApiError/Error already carries
// a message worth showing, anything else falls back to a generic one rather
// than surfacing "[object Object]" or similar.
function actionFailureMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function SettingsScreen() {
  const { session, logout } = useAuth();
  const registrationStatus = useDeviceRegistrationStatus();
  const registrationFailure = registrationFailureMessage(registrationStatus);
  const load = useCallback(() => api.listDeviceTokens(), []);
  const { data, error, loading, refresh } = useAsync(load, []);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const onRevoke = async (id: string) => {
    setRevokingId(id);
    setRevokeError(null);
    try {
      await api.unregisterDeviceToken(id);
      refresh();
    } catch (err) {
      setRevokeError(
        actionFailureMessage(err, "Couldn't revoke this device. Check your connection and try again.")
      );
    } finally {
      setRevokingId(null);
    }
  };

  const onSignOut = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
      router.replace('/login');
    } catch (err) {
      setSignOutError(
        actionFailureMessage(err, "Couldn't sign you out. Check your connection and try again.")
      );
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <View style={styles.container}>
      {session && (
        <Text style={styles.email} testID="settings-email">
          {session.email}
        </Text>
      )}

      {registrationFailure && (
        <Text style={styles.errorText} testID="device-registration-error">
          {registrationFailure}
        </Text>
      )}

      <Text style={styles.sectionTitle}>Registered devices</Text>

      {error && (
        <Text style={styles.errorText} testID="devices-error">
          {error.message}
        </Text>
      )}

      {revokeError && (
        <Text style={styles.errorText} testID="revoke-device-error">
          {revokeError}
        </Text>
      )}

      <FlatList
        testID="devices-list"
        data={data ?? []}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} />}
        ListEmptyComponent={
          !loading ? <Text style={styles.emptyText}>No devices registered.</Text> : undefined
        }
        renderItem={({ item }) => (
          <View style={styles.deviceRow} testID={`device-row-${item.id}`}>
            <View style={styles.deviceInfo}>
              <Text style={styles.deviceTitle}>
                {item.platform.toUpperCase()} · {item.provider.toUpperCase()}
              </Text>
              <Text style={styles.deviceSubtitle}>{deviceStatusLabel(item)}</Text>
            </View>
            {!item.revoked_at && (
              <Pressable
                testID={`revoke-device-${item.id}`}
                onPress={() => onRevoke(item.id)}
                disabled={revokingId === item.id}
                style={styles.revokeButton}
              >
                <Text style={styles.revokeText}>
                  {revokingId === item.id ? 'Revoking…' : 'Revoke'}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      />

      {signOutError && (
        <Text style={styles.errorText} testID="sign-out-error">
          {signOutError}
        </Text>
      )}

      <Pressable
        testID="sign-out"
        style={[styles.signOutButton, signingOut && styles.buttonDisabled]}
        onPress={onSignOut}
        disabled={signingOut}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 12 },
  email: { fontSize: 14, color: '#555' },
  sectionTitle: { fontSize: 14, fontWeight: '700', marginTop: 8 },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F5F6F8',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  deviceInfo: { flex: 1 },
  deviceTitle: { fontSize: 15, fontWeight: '600' },
  deviceSubtitle: { fontSize: 13, color: '#666', marginTop: 2 },
  revokeButton: {
    borderWidth: 1,
    borderColor: '#B00020',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  revokeText: { color: '#B00020', fontWeight: '600' },
  emptyText: { color: '#777', textAlign: 'center', marginTop: 12 },
  errorText: { color: '#B00020' },
  signOutButton: {
    backgroundColor: '#B00020',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  signOutText: { color: '#fff', fontWeight: '600' },
});
