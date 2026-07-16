import type { ApiErrorCode } from "../domain/states.js";

export class ProxyServiceError extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ProxyServiceError";
  }
}
