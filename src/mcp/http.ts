// HTTP routes of the MCP server, mounted in the main server when MCP_ENABLED is true.
//
//   POST /mcp                      MCP over streamable HTTP. Header: Authorization: Bearer <token>
//   GET  /mcp/connect              A page for a person: shows the bot link, waits for Allow, then shows the token
//   POST /mcp/pair                 Starts a pairing: { clientName } -> { pairingId, secret, code, link, expiresAt }
//   POST /mcp/pair/:id/token       { secret } -> 200 { token } once allowed, 202 while waiting, 403/410 otherwise
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { collectPairing, connectionForToken, mayStartPairing, now as clockNow, shortCode, startPairing } from '../db/index.js';
import { createMcpServer, type McpDeps } from './server.js';

export function pairingLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=mcp_${code}`;
}

export function createMcpApp(deps: McpDeps): Hono {
  const app = new Hono();
  const at = () => (deps.now ?? clockNow)();

  app.post('/mcp/pair', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { clientName?: unknown };
    if (!mayStartPairing(deps.db, at())) return c.json({ status: 'busy', message: 'Too many connections are being started. Try again in a minute.' }, 429);
    const { pairing, code, secret } = startPairing(deps.db, { clientName: body.clientName, now: at() });
    return c.json({
      pairingId: pairing.id,
      secret,
      code: shortCode(code),
      link: pairingLink(deps.config.botUsername, code),
      expiresAt: pairing.expiresAt,
      instructions: `Open the link, or send /connect ${shortCode(code)} to @${deps.config.botUsername} in a private chat, then tap Allow.`,
    }, 201);
  });

  app.post('/mcp/pair/:id/token', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { secret?: unknown };
    const result = collectPairing(deps.db, { pairingId: c.req.param('id'), secret: typeof body.secret === 'string' ? body.secret : '', now: at() });
    switch (result.kind) {
      case 'token': return c.json({ token: result.token, clientName: result.connection.clientName, mcpUrl: new URL('/mcp', c.req.url).href });
      case 'waiting': return c.json({ status: 'waiting' }, 202);
      case 'denied': return c.json({ status: 'denied' }, 403);
      case 'collected': return c.json({ status: 'collected' }, 410);
      case 'expired': return c.json({ status: 'expired' }, 410);
      default: return c.json({ status: 'unknown' }, 404);
    }
  });

  app.get('/mcp/connect', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    return c.html(connectPage(deps.config.botUsername));
  });

  app.all('/mcp', async (c) => {
    const header = c.req.header('Authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
    const connection = connectionForToken(deps.db, token, at());
    if (!connection) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'Connect this client first: open /mcp/connect, or ask the bot for /connect.' }, 401);
    }
    // Stateless: a server and transport per request, so any instance can answer and nothing is kept in memory.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(deps, connection);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  return app;
}

/** A plain page: no framework, same colours as the Mini App, works in light and dark. */
function connectPage(botUsername: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an AI client</title>
<style>
:root{--bg:#f6f9fc;--surface:#fff;--text:#0a2540;--muted:#5b6676;--accent:#0b5d4e;--on:#fff;--line:#dde3ea;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#000;--surface:#1c1c1e;--text:#fff;--muted:#a1a1a6;--accent:#2fbf95;--on:#000;--line:rgba(255,255,255,.12);color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif}
main{max-width:520px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;margin:0 0 8px}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;margin:16px 0}
p{margin:0 0 12px;color:var(--muted)}label{display:block;font-size:13px;font-weight:500;margin-bottom:6px}
input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #8792a2;border-radius:10px;background:var(--surface);color:var(--text)}
button,a.btn{display:inline-flex;justify-content:center;align-items:center;width:100%;box-sizing:border-box;min-height:48px;margin-top:12px;border:0;border-radius:12px;background:var(--accent);color:var(--on);font-size:16px;font-weight:600;text-decoration:none;cursor:pointer}
code,.code{font:600 20px ui-monospace,Menlo,monospace;letter-spacing:.08em}.token{font:13px ui-monospace,Menlo,monospace;word-break:break-all;background:var(--bg);padding:12px;border-radius:10px;display:block}
[hidden]{display:none}
</style></head><body><main>
<h1>Connect an AI client</h1>
<p>Lets an AI app such as Claude read and change your TripSplitter expenses, as you, in all your groups. You approve it in Telegram.</p>
<section class="card" id="start">
<label for="name">Which app is this for?</label>
<input id="name" value="Claude" maxlength="60" autocomplete="off">
<button id="go" type="button">Get a link</button>
</section>
<section class="card" id="wait" hidden>
<p>Open this link on your phone and tap <strong>Allow</strong> in the chat with @${botUsername}:</p>
<a class="btn" id="link" href="#" target="_blank" rel="noopener">Open Telegram</a>
<p style="margin-top:16px">Or send this to @${botUsername} in a private chat:</p>
<p><span class="code">/connect <span id="code"></span></span></p>
<p id="status">Waiting for you to tap Allow…</p>
</section>
<section class="card" id="done" hidden>
<p><strong>Connected.</strong> Add this to your AI app as a remote MCP server. The token is shown only once.</p>
<label>Server URL</label><span class="token" id="url"></span>
<label style="margin-top:12px">Header</label><span class="token" id="token"></span>
<p style="margin-top:12px">You can see and revoke connections by sending /connections to @${botUsername}.</p>
</section>
<script>
const $=id=>document.getElementById(id);
$('go').onclick=async()=>{
  $('go').disabled=true;
  const r=await fetch('/mcp/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientName:$('name').value})});
  const p=await r.json();
  $('start').hidden=true;$('wait').hidden=false;$('link').href=p.link;$('code').textContent=p.code;
  const poll=async()=>{
    const t=await fetch('/mcp/pair/'+p.pairingId+'/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:p.secret})});
    if(t.status===202){setTimeout(poll,2000);return;}
    const b=await t.json();
    if(t.ok){$('wait').hidden=true;$('done').hidden=false;$('url').textContent=b.mcpUrl;$('token').textContent='Authorization: Bearer '+b.token;}
    else $('status').textContent=b.status==='denied'?'You tapped Deny. Nothing was connected.':'This link expired. Reload the page to start again.';
  };
  setTimeout(poll,2000);
};
</script>
</main></body></html>`;
}
