// Owns the static server and the browser for `pass.js`, so that every way out — including a
// browser that never launches — closes both. A listening server keeps Node's event loop alive,
// so a launch failure that skipped `server.close()` left the process printing its error and then
// never exiting: on Windows CI that was a job sitting `in_progress` until cancelled by hand
// (issue #521).
export async function withServerAndBrowser({ startServer, launchBrowser }, body) {
  const server = await startServer();
  let browser;
  try {
    browser = await launchBrowser();
    return await body(server, browser);
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await server.close();
    }
  }
}
