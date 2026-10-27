import { extractDeepLinkData, incidentRouteFor } from '../push-notifications';
import type { NotificationResponse } from 'expo-notifications';

// expo-notifications 58 installs a default notification handler as soon as it is
// imported, and jest-expo's native-module mock hands back subscriptions without
// remove(); the module under test then replaces that handler and throws. These
// tests only exercise the pure helpers, so the handler setup is stubbed out.
jest.mock('expo-notifications', () => ({ setNotificationHandler: jest.fn() }));

function fakeResponse(data: Record<string, unknown> | undefined): NotificationResponse {
  return {
    notification: {
      date: Date.now(),
      request: {
        identifier: 'req-1',
        content: {
          title: 'A target is failing',
          subtitle: null,
          body: 'A monitored target has started failing its checks.',
          data,
          categoryIdentifier: null,
          sound: 'default',
        } as never,
        trigger: { type: 'push' },
      },
    },
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  };
}

describe('extractDeepLinkData', () => {
  it('extracts incident_id, target_id, and kind from the data payload', () => {
    const response = fakeResponse({
      kind: 'opened',
      incident_id: '42',
      target_id: '0f6b6f5e-0000-4000-8000-000000000001',
    });
    expect(extractDeepLinkData(response)).toEqual({
      kind: 'opened',
      incident_id: '42',
      target_id: '0f6b6f5e-0000-4000-8000-000000000001',
    });
  });

  it('defaults kind to "opened" when absent', () => {
    const response = fakeResponse({ incident_id: '42', target_id: 'target-1' });
    expect(extractDeepLinkData(response)?.kind).toBe('opened');
  });

  it('returns null when data is missing entirely', () => {
    expect(extractDeepLinkData(fakeResponse(undefined))).toBeNull();
  });

  it('returns null when incident_id is missing', () => {
    expect(extractDeepLinkData(fakeResponse({ target_id: 'target-1' }))).toBeNull();
  });

  it('returns null when target_id is missing', () => {
    expect(extractDeepLinkData(fakeResponse({ incident_id: '42' }))).toBeNull();
  });

  it('returns null when incident_id is not a string (defensive against a malformed payload)', () => {
    expect(
      extractDeepLinkData(fakeResponse({ incident_id: 42, target_id: 'target-1' }))
    ).toBeNull();
  });

  it('returns null when incident_id is an empty string', () => {
    expect(
      extractDeepLinkData(fakeResponse({ incident_id: '', target_id: 'target-1' }))
    ).toBeNull();
  });
});

describe('incidentRouteFor', () => {
  it('builds the /targets/[targetId]/incidents/[incidentId] route', () => {
    expect(incidentRouteFor({ kind: 'opened', incident_id: '42', target_id: 'target-1' })).toBe(
      '/targets/target-1/incidents/42'
    );
  });

  it('URL-encodes ids', () => {
    expect(
      incidentRouteFor({ kind: 'opened', incident_id: '42', target_id: 'a/b c' })
    ).toBe('/targets/a%2Fb%20c/incidents/42');
  });
});
