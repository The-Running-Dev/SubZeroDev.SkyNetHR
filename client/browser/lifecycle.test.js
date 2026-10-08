// Self-test for lifecycle.js. No browser involved — injected fakes — so this runs in the
// ordinary `npm test`. Covers issue #521: a browser launch failure must still close the static
// server, or the server's listening socket keeps the process alive after the error is printed.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { withServerAndBrowser } from './lifecycle.js';

function fakeServer() {
  return { origin: 'http://127.0.0.1:0', close: mock.fn(async () => {}) };
}

test('withServerAndBrowser closes the server when the browser fails to launch', async () => {
  const server = fakeServer();
  const launchError = new Error('browser did not write DevToolsActivePort within 15000ms');
  const body = mock.fn(async () => {});

  await assert.rejects(
    withServerAndBrowser(
      {
        startServer: async () => server,
        launchBrowser: async () => {
          throw launchError;
        },
      },
      body,
    ),
    launchError,
  );
  assert.equal(server.close.mock.callCount(), 1);
  assert.equal(body.mock.callCount(), 0);
});

test('withServerAndBrowser closes the server even when closing the browser throws', async () => {
  const server = fakeServer();
  const browser = {
    close: mock.fn(async () => {
      throw new Error('kill failed');
    }),
  };

  await assert.rejects(
    withServerAndBrowser({ startServer: async () => server, launchBrowser: async () => browser }, async () => 'done'),
    /kill failed/,
  );
  assert.equal(browser.close.mock.callCount(), 1);
  assert.equal(server.close.mock.callCount(), 1);
});

test('withServerAndBrowser returns the body result and closes browser then server', async () => {
  const order = [];
  const server = { close: async () => order.push('server') };
  const browser = { close: async () => order.push('browser') };

  const result = await withServerAndBrowser(
    { startServer: async () => server, launchBrowser: async () => browser },
    async (s, b) => {
      assert.equal(s, server);
      assert.equal(b, browser);
      return 42;
    },
  );
  assert.equal(result, 42);
  assert.deepEqual(order, ['browser', 'server']);
});
