import assert from "node:assert/strict";
import test from "node:test";

import { acceptsPairingToken, localPairingToken } from "./pairing";

const configuredToken = "random-remote-token";
const localRequest = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" };

test("accepts the configured token from any origin", () => {
  assert.equal(acceptsPairingToken(configuredToken, configuredToken, {
    host: "example.com",
    origin: "https://example.com",
    forwardedByCloudflare: true,
  }), true);
});

test("accepts the development token from loopback browser origins", () => {
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, localRequest), true);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: "localhost:8787",
    origin: "http://localhost:8787",
  }), true);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: "[::1]:8787",
    origin: "http://[::1]:8787",
  }), true);
});

test("rejects the development token from non-loopback origins", () => {
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: "example.com",
    origin: "https://example.com",
  }), false);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: "127.0.0.1.example.com",
    origin: "https://127.0.0.1.example.com",
  }), false);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {}), false);
});

test("rejects the development token from proxied or inconsistent requests", () => {
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    ...localRequest,
    forwardedByCloudflare: true,
  }), false);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: "example.com",
    origin: localRequest.origin,
  }), false);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: localRequest.host,
    origin: "https://example.com",
  }), false);
});

test("rejects malformed and non-HTTP origins", () => {
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: localRequest.host,
    origin: "not a URL",
  }), false);
  assert.equal(acceptsPairingToken(localPairingToken, configuredToken, {
    host: localRequest.host,
    origin: "file://localhost/app",
  }), false);
});
