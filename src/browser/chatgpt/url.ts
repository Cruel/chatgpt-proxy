import type { Page } from "playwright";

import type { RemoteConversationReference } from "../adapter.js";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{6,}$/;

function decodedSegments(url: URL): readonly string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

export function extractConversationId(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const queryId =
    url.searchParams.get("conversation_id") ??
    url.searchParams.get("conversationId");
  if (queryId !== null && CONVERSATION_ID_PATTERN.test(queryId)) {
    return queryId;
  }

  const segments = decodedSegments(url);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === "c") {
      const candidate = segments[index + 1];
      if (candidate !== undefined && CONVERSATION_ID_PATTERN.test(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function projectFingerprint(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const segments = decodedSegments(url);
  return (
    segments.find((segment) => segment.startsWith("g-p-")) ??
    segments.find((segment) => segment.startsWith("project-")) ??
    null
  );
}

export function isConfiguredProjectUrl(
  observedValue: string,
  configuredValue: string,
): boolean {
  let observed: URL;
  let configured: URL;
  try {
    observed = new URL(observedValue);
    configured = new URL(configuredValue);
  } catch {
    return false;
  }
  if (observed.origin !== configured.origin) {
    return false;
  }

  const fingerprint = projectFingerprint(configuredValue);
  if (fingerprint !== null) {
    return decodedSegments(observed).includes(fingerprint);
  }

  const configuredPath = configured.pathname.replace(/\/+$/, "");
  const observedPath = observed.pathname.replace(/\/+$/, "");
  return (
    observedPath === configuredPath ||
    observedPath.startsWith(`${configuredPath}/`)
  );
}

export async function conversationReferenceFromPage(
  page: Page,
): Promise<RemoteConversationReference | null> {
  const url = page.url();
  const conversationId = extractConversationId(url);
  if (conversationId === null) {
    return null;
  }
  const title = (await page.title().catch(() => "")).trim();
  return {
    conversationId,
    url,
    title: title.length === 0 ? null : title,
  };
}
