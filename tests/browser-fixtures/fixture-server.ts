import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FixtureSessionState =
  | "ready"
  | "auth_required"
  | "verification_required";

export interface BrowserFixtureServer {
  readonly baseUrl: string;
  setSessionState(state: FixtureSessionState): void;
  close(): Promise<void>;
}

interface FixturePage {
  readonly state: "ready" | "auth_required" | "verification_required" | "unavailable";
  readonly title: string;
  readonly body: string;
  readonly detail?: string;
}

const FIXTURE_PAGES: Readonly<Record<string, FixturePage>> = {
  "/logged-out": {
    state: "auth_required",
    title: "Logged out",
    detail: "Fixture requires login",
    body: '<main><h1>Welcome</h1><button type="button">Log in</button></main>',
  },
  "/verification": {
    state: "verification_required",
    title: "Verification required",
    detail: "Fixture requires interactive verification",
    body: '<main data-testid="challenge-stage"><h1>Verify you are human</h1></main>',
  },
  "/conversation": {
    state: "ready",
    title: "Conversation",
    body: '<main><article data-testid="assistant-turn">Hello</article><div id="prompt-textarea" contenteditable="true" role="textbox"></div></main>',
  },
  "/generating": {
    state: "ready",
    title: "Generating",
    body: '<main><article data-testid="assistant-turn">Partial response</article><button data-testid="stop-button">Stop</button></main>',
  },
  "/tool-progress": {
    state: "ready",
    title: "Tool progress",
    body: '<main><article data-testid="assistant-turn"><div data-testid="tool-progress">Searching</div></article></main>',
  },
  "/final-response": {
    state: "ready",
    title: "Final response",
    body: '<main><article data-testid="assistant-turn"><p>Final answer</p><button aria-label="Copy">Copy</button></article></main>',
  },
  "/tool-failed": {
    state: "ready",
    title: "Tool failed",
    body: '<main><div role="alert">Tool execution failed</div></main>',
  },
  "/rate-limited": {
    state: "ready",
    title: "Rate limited",
    body: '<main><div role="alert">You have reached the current usage limit</div></main>',
  },
  "/generic-error": {
    state: "ready",
    title: "Generic error",
    body: '<main><div role="alert">Something went wrong</div></main>',
  },
  "/conversation-actions": {
    state: "ready",
    title: "Conversation actions",
    body: '<main><button aria-label="Conversation options">Options</button><div role="menu"><button role="menuitem">Delete</button></div></main>',
  },
  "/delete-confirmation": {
    state: "ready",
    title: "Delete confirmation",
    body: '<main><div role="dialog" aria-modal="true"><h2>Delete chat?</h2><button>Delete</button><button>Cancel</button></div></main>',
  },
  "/missing-conversation": {
    state: "ready",
    title: "Missing conversation",
    body: '<main><div data-testid="conversation-missing">Conversation not found</div></main>',
  },
  "/changed-selectors": {
    state: "unavailable",
    title: "Changed selectors",
    detail: "Expected ChatGPT controls are absent",
    body: "<main><h1>Unknown page structure</h1></main>",
  },
  "/storage": {
    state: "ready",
    title: "Persistent storage",
    body: '<main><div id="prompt-textarea" contenteditable="true" role="textbox"></div></main>',
  },
};

function html(page: FixturePage): string {
  const detail = page.detail === undefined
    ? ""
    : ` data-detail="${page.detail.replaceAll('"', "&quot;")}"`;
  return `<!doctype html>
<html lang="en" data-chatgpt-proxy-state="${page.state}"${detail}>
  <head><meta charset="utf-8"><title>${page.title}</title></head>
  <body>${page.body}</body>
</html>`;
}

function sessionHtml(): string {
  return `<!doctype html>
<html lang="en" data-chatgpt-proxy-state="auth_required" data-detail="Fixture requires login">
  <head><meta charset="utf-8"><title>Fixture session</title></head>
  <body>
    <main id="content"><h1>Logged out</h1><button id="login" type="button">Log in</button></main>
    <script>
      const root = document.documentElement;
      const content = document.getElementById('content');
      async function refresh() {
        const response = await fetch('/session-state', { cache: 'no-store' });
        const payload = await response.json();
        root.setAttribute('data-chatgpt-proxy-state', payload.state);
        if (payload.state === 'ready') {
          root.removeAttribute('data-detail');
          content.innerHTML = '<h1>Conversation ready</h1><div id="prompt-textarea" contenteditable="true" role="textbox"></div>';
        } else if (payload.state === 'verification_required') {
          root.setAttribute('data-detail', 'Fixture requires interactive verification');
          content.innerHTML = '<h1 data-testid="challenge-stage">Verify you are human</h1>';
        } else {
          root.setAttribute('data-detail', 'Fixture requires login');
          if (!document.getElementById('login')) {
            content.innerHTML = '<h1>Logged out</h1><button id="login" type="button">Log in</button>';
          }
        }
      }
      document.addEventListener('click', async (event) => {
        if (event.target instanceof HTMLElement && event.target.id === 'login') {
          await fetch('/session-login', { method: 'POST' });
          await refresh();
        }
      });
      setInterval(() => void refresh(), 50);
      void refresh();
    </script>
  </body>
</html>`;
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export async function startBrowserFixtureServer(): Promise<BrowserFixtureServer> {
  let sessionState: FixtureSessionState = "auth_required";
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/session") {
        sendHtml(response, sessionHtml());
        return;
      }
      if (requestUrl.pathname === "/session-state") {
        sendJson(response, { state: sessionState });
        return;
      }
      if (requestUrl.pathname === "/session-login" && request.method === "POST") {
        sessionState = "ready";
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      const fixture = FIXTURE_PAGES[requestUrl.pathname];
      if (fixture !== undefined) {
        sendHtml(response, html(fixture));
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Fixture not found");
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setSessionState(state) {
      sessionState = state;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}
