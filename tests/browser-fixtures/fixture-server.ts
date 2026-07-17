import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FixtureSessionState =
  | "ready"
  | "auth_required"
  | "verification_required";

export interface BrowserFixtureServer {
  readonly baseUrl: string;
  setSessionState(state: FixtureSessionState): void;
  isConversationDeleted(conversationId: string): boolean;
  deleteRequestCount(conversationId: string): number;
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

function hydratingHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Loading</title></head>
  <body>
    <main id="content"></main>
    <script>
      setTimeout(() => {
        document.title = 'Conversation';
        document.getElementById('content').innerHTML = '<div id="prompt-textarea" contenteditable="true" role="textbox"></div>';
      }, 250);
    </script>
  </body>
</html>`;
}

function interactiveChatHtml(
  mode: "project" | "conversation",
  scenario: string,
  conversationId: string,
): string {
  const requiresNewChat = scenario === "requires-new-chat";
  const delayedComposer = scenario === "delayed-composer";
  const deletedRedirectShell = scenario === "deleted-redirect-shell";
  const composerVisibility =
    requiresNewChat || delayedComposer || deletedRedirectShell ? " hidden" : "";
  const initialTurns =
    mode === "conversation" && !deletedRedirectShell
      ? '<article data-testid="assistant-turn" data-message-author-role="assistant"><div class="markdown">Existing answer</div><button aria-label="Copy">Copy</button></article>'
      : "";
  const deletionControls =
    mode === "conversation" &&
    scenario !== "delete-missing-action-menu" &&
    !deletedRedirectShell
      ? `
      <button data-testid="conversation-options-button" aria-label="Open conversation options" type="button">Options</button>
      <div id="conversation-menu" role="menu" hidden>
        ${scenario === "delete-missing-menu-item" ? "" : '<div data-testid="delete-chat-menu-item" role="menuitem" tabindex="0">Delete</div>'}
      </div>`
      : "";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>ChatGPT fixture</title></head>
  <body>
    <main>
      <h1>Project fixture</h1>
      <button data-testid="new-chat-button" type="button">New chat</button>
      ${deletionControls}
      <section id="turns">${initialTurns}</section>
      <div id="prompt-textarea" contenteditable="true" role="textbox"${composerVisibility}></div>
      <button data-testid="send-button" aria-label="Send prompt" type="button"${composerVisibility}>Send</button>
    </main>
    <script>
      const scenario = ${JSON.stringify(scenario)};
      const conversationId = ${JSON.stringify(conversationId)};
      const recoveryStorageKey = 'chatgpt-proxy-recovery-' + conversationId + '-' + scenario;
      const composer = document.getElementById('prompt-textarea');
      const turns = document.getElementById('turns');
      const send = document.querySelector('[data-testid="send-button"]');
      const conversationMenuButton = document.querySelector('[data-testid="conversation-options-button"]');
      const conversationMenu = document.getElementById('conversation-menu');
      const deleteMenuItem = document.querySelector('[data-testid="delete-chat-menu-item"]');
      document.querySelector('[data-testid="new-chat-button"]').addEventListener('click', () => {
        composer.hidden = false;
        send.hidden = false;
        composer.focus();
      });
      if (scenario === 'changed-selectors') {
        composer.remove();
        send.remove();
        document.querySelector('[data-testid="new-chat-button"]').remove();
      }
      if (scenario === 'delayed-composer') {
        setTimeout(() => {
          composer.hidden = false;
          send.hidden = false;
        }, 350);
      }
      if (scenario === 'deleted-redirect-shell') {
        setTimeout(() => {
          composer.hidden = false;
          send.hidden = false;
        }, 150);
        setTimeout(() => {
          history.replaceState(null, '', '/project/example');
        }, 500);
      }

      conversationMenuButton?.addEventListener('click', () => {
        conversationMenu.hidden = false;
      });
      deleteMenuItem?.addEventListener('click', () => {
        conversationMenu.hidden = true;
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        if (scenario === 'delete-malformed-dialog') {
          dialog.innerHTML = '<h2>Confirm action?</h2><button data-testid="delete-conversation-confirm-button">Delete</button><button>Cancel</button>';
        } else {
          dialog.innerHTML = '<h2>Delete chat?</h2><p>This will delete Fixture Conversation.</p><button data-testid="delete-conversation-confirm-button">Delete</button><button>Cancel</button>';
        }
        document.querySelector('main').append(dialog);
        dialog.querySelector('button:last-child').addEventListener('click', () => dialog.remove());
        dialog.querySelector('[data-testid="delete-conversation-confirm-button"]').addEventListener('click', async () => {
          dialog.remove();
          if (scenario === 'delete-ambiguous') {
            return;
          }
          await fetch('/fixture-delete/' + conversationId, { method: 'POST' });
          if (scenario !== 'delete-verify-by-reload') {
            history.replaceState(null, '', '/project/example');
            document.querySelector('main').innerHTML = '<h1>Project fixture</h1><div id="prompt-textarea" contenteditable="true" role="textbox"></div>';
          }
        });
      });

      function addAlert(text) {
        const alert = document.createElement('div');
        alert.setAttribute('role', 'alert');
        alert.textContent = text;
        document.querySelector('main').append(alert);
      }

      function addDialog(text) {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.textContent = text;
        document.querySelector('main').append(dialog);
      }

      function addUserTurn(message) {
        const turn = document.createElement('article');
        turn.dataset.testid = 'user-turn';
        turn.dataset.messageAuthorRole = 'user';
        turn.textContent = message;
        turns.append(turn);
      }

      function addAssistantProgress(message) {
        const turn = document.createElement('article');
        turn.dataset.testid = 'assistant-turn';
        turn.dataset.messageAuthorRole = 'assistant';
        turn.innerHTML = '<div class="markdown"><p>Intermediate text that must not be returned</p></div><div data-testid="tool-progress">Searching fixture data</div>';
        const stop = document.createElement('button');
        stop.dataset.testid = 'stop-button';
        stop.textContent = 'Stop';
        document.querySelector('main').append(stop);
        turns.append(turn);

        setTimeout(() => {
          if (scenario === 'recovery-after-timeout') {
            return;
          }
          if (scenario === 'tool-failed') {
            stop.remove();
            addAlert('Tool execution failed');
            return;
          }
          if (scenario === 'tool-aborted') {
            stop.remove();
            addAlert('The tool call was aborted');
            return;
          }
          if (scenario === 'generic-error') {
            stop.remove();
            addAlert('Something went wrong');
            return;
          }
          if (scenario === 'confirmation') {
            stop.remove();
            addDialog('Allow ChatGPT to continue?');
            return;
          }
          const markdown = turn.querySelector('.markdown');
          markdown.innerHTML = '<p>Final response to: ' + message.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</p><p>Second paragraph.</p>';
          turn.querySelector('[data-testid="tool-progress"]').remove();
          stop.remove();
          if (scenario !== 'stable-no-copy') {
            const copy = document.createElement('button');
            copy.setAttribute('aria-label', 'Copy');
            copy.textContent = 'Copy';
            turn.append(copy);
          }
        }, 120);
      }

      function addCompletedAssistant(message) {
        const turn = document.createElement('article');
        turn.dataset.testid = 'assistant-turn';
        turn.dataset.messageAuthorRole = 'assistant';
        const markdown = document.createElement('div');
        markdown.className = 'markdown';
        const first = document.createElement('p');
        first.textContent = 'Recovered response to: ' + message;
        markdown.append(first);
        turn.append(markdown);
        const copy = document.createElement('button');
        copy.setAttribute('aria-label', 'Copy');
        copy.textContent = 'Copy';
        turn.append(copy);
        turns.append(turn);
      }

      const pendingRecoveryMessage = localStorage.getItem(recoveryStorageKey);
      if (pendingRecoveryMessage !== null) {
        const restore = () => {
          addUserTurn(pendingRecoveryMessage);
          addCompletedAssistant(pendingRecoveryMessage);
          localStorage.removeItem(recoveryStorageKey);
        };
        if (scenario === 'late-ambiguous-submission') {
          setTimeout(restore, 150);
        } else if (scenario === 'recovery-after-timeout') {
          restore();
        }
      }

      send.addEventListener('click', () => {
        const message = composer.innerText.trim();
        if (message.length === 0) return;
        if (scenario === 'no-confirmation') return;
        if (scenario === 'rate-limited') {
          addAlert('You have reached the current usage limit');
          return;
        }
        if (scenario === 'late-ambiguous-submission') {
          localStorage.setItem(recoveryStorageKey, message);
          composer.innerHTML = '';
          return;
        }
        if (scenario === 'recovery-after-timeout') {
          localStorage.setItem(recoveryStorageKey, message);
        }
        if (scenario === 'same-count-response') {
          composer.innerHTML = '';
          const existing = turns.querySelector('[data-message-author-role="assistant"]');
          existing.innerHTML = '<div class="markdown"><p>Final response to: ' + message.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</p></div><button data-testid="copy-turn-action-button">Copy</button>';
          existing.dataset.messageId = 'replacement-response';
          return;
        }
        addUserTurn(message);
        composer.innerHTML = '';
        if (!location.pathname.includes('/c/')) {
          history.replaceState(null, '', '/c/' + conversationId + location.search);
        }
        addAssistantProgress(message);
      });

      composer.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send.click();
        }
      });
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
  const deletedConversationIds = new Set<string>();
  const deleteRequestCounts = new Map<string, number>();
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/session") {
        sendHtml(response, sessionHtml());
        return;
      }
      if (requestUrl.pathname === "/hydrating") {
        sendHtml(response, hydratingHtml());
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
      if (
        request.method === "POST" &&
        requestUrl.pathname.startsWith("/fixture-delete/")
      ) {
        const conversationId = decodeURIComponent(
          requestUrl.pathname.slice("/fixture-delete/".length),
        );
        deleteRequestCounts.set(
          conversationId,
          (deleteRequestCounts.get(conversationId) ?? 0) + 1,
        );
        deletedConversationIds.add(conversationId);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      if (requestUrl.pathname === "/project/example") {
        sendHtml(
          response,
          interactiveChatHtml(
            "project",
            requestUrl.searchParams.get("scenario") ?? "tool-progress",
            "fixture-conversation-1",
          ),
        );
        return;
      }
      if (requestUrl.pathname.startsWith("/c/")) {
        const conversationId = requestUrl.pathname.slice("/c/".length);
        if (
          conversationId === "missing-conversation" ||
          deletedConversationIds.has(conversationId)
        ) {
          sendHtml(response, html(FIXTURE_PAGES["/missing-conversation"]!));
          return;
        }
        sendHtml(
          response,
          interactiveChatHtml(
            "conversation",
            requestUrl.searchParams.get("scenario") ?? "tool-progress",
            conversationId,
          ),
        );
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
    isConversationDeleted(conversationId) {
      return deletedConversationIds.has(conversationId);
    },
    deleteRequestCount(conversationId) {
      return deleteRequestCounts.get(conversationId) ?? 0;
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
