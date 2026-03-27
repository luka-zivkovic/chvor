import { Hono } from "hono";

const social = new Hono();

/**
 * OAuth callback endpoint — Composio redirects here after the user authorizes.
 * Returns a simple HTML page confirming the connection.
 * This is NOT behind auth middleware since the browser redirect comes from Composio.
 */
social.get("/callback", (c) => {
  const status = c.req.query("status") ?? "unknown";
  const accountId = c.req.query("connected_account_id") ?? "";

  const success = status === "success" || status === "active";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chvor — ${success ? "Account Connected" : "Connection Failed"}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; margin: 0;
      background: #181818; color: #e4e4e8;
    }
    .card {
      text-align: center; padding: 3rem; border-radius: 1rem;
      background: #222; max-width: 420px;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #999; font-size: 0.95rem; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
    <h1>${success ? "Account Connected!" : "Connection Failed"}</h1>
    <p>${success ? "You can close this tab and return to Chvor." : `Status: ${status}. Please try again in Chvor.`}</p>
  </div>
</body>
</html>`;

  return c.html(html);
});

export default social;
