export function normalizeFixtureName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (normalized.length < 3 || normalized.length > 80) {
    throw new Error("Fixture name must contain 3 to 80 URL-safe characters");
  }
  return normalized;
}

function redactAttributeUrls(html: string): string {
  return html.replaceAll(
    /(href|src|action)=(['"])([^'"]+)\2/gi,
    (_match, attribute: string, quote: string, rawUrl: string) => {
      try {
        const parsed = new URL(rawUrl, "https://fixture.invalid/");
        parsed.search = "";
        parsed.hash = "";
        const value = parsed.origin === "https://fixture.invalid"
          ? parsed.pathname
          : parsed.toString();
        return `${attribute}=${quote}${value}${quote}`;
      } catch {
        return `${attribute}=${quote}[redacted-url]${quote}`;
      }
    },
  );
}

export function sanitizeDiagnosticHtml(html: string): string {
  return `${redactAttributeUrls(html)
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replaceAll(/\s(?:value|data-token|nonce)=(['"])[\s\S]*?\1/gi, "")
    .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replaceAll(/\/home\/[^/\s'"<]+/g, "/home/USER")
    .replaceAll(/g-p-[a-f0-9]{12,}/gi, "g-p-REDACTED")
    .replaceAll(/\/c\/[a-z0-9-]{12,}/gi, "/c/REDACTED")
    .trim()}\n`;
}
