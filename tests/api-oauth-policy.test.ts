import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  googleWorkspaceApiPolicy,
  googleWorkspaceServicePolicies,
  isValidApiOAuthConnectionPolicy,
} from '../src/config/api-oauth-policy.ts';

test('Google Workspace OAuth policy derives exact hosts, paths, and read-only methods', () => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ];
  assert.deepEqual(googleWorkspaceApiPolicy(scopes), {
    allowedHosts: ['gmail.googleapis.com', 'www.googleapis.com'],
    pathPrefixes: ['/gmail/v1/users/me', '/calendar/v3', '/drive/v3'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'HEAD'],
  });
});

test('Google Workspace write scopes opt into write methods without widening hosts or paths', () => {
  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/drive',
  ];
  assert.deepEqual(googleWorkspaceApiPolicy(scopes), {
    allowedHosts: ['gmail.googleapis.com', 'www.googleapis.com'],
    pathPrefixes: ['/gmail/v1/users/me', '/calendar/v3', '/drive/v3', '/upload/drive/v3'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
});

test('Google Workspace runtime policies keep mixed service methods separate', () => {
  assert.deepEqual(
    googleWorkspaceServicePolicies([
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/drive.readonly',
    ]),
    [
      {
        allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1/users/me'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      },
      {
        allowedHosts: ['www.googleapis.com'],
        pathPrefixes: ['/drive/v3'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET', 'HEAD'],
      },
    ],
  );
});

test('OAuth policy validation rejects a client-side host or method widening', () => {
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const expected = googleWorkspaceApiPolicy(scopes);
  const base = {
    ...expected,
    authMode: 'oauth',
    oauthProvider: 'google',
    oauthScopes: scopes,
  };
  assert.equal(isValidApiOAuthConnectionPolicy(base), true);
  assert.equal(
    isValidApiOAuthConnectionPolicy({
      ...base,
      allowedHosts: [...base.allowedHosts, 'evil.example.com'],
    }),
    false,
  );
  assert.equal(
    isValidApiOAuthConnectionPolicy({ ...base, allowedMethods: ['GET', 'DELETE'] }),
    false,
  );
  assert.equal(
    isValidApiOAuthConnectionPolicy({
      ...base,
      oauthScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
      ],
    }),
    false,
  );
});
