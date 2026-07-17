import { timingSafeEqual } from "node:crypto";

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { ZodError, type ZodType } from "zod";

import type { AppConfig } from "../config/schema.js";
import { apiErrorCodeSchema } from "../domain/states.js";
import { ProxyServiceError, type ProxyService } from "../service/index.js";
import type { MutationResult } from "../service/proxy-service.js";
import { APP_VERSION } from "../version.js";
import {
  apiErrorResponseSchema,
  browserStatusResponseSchema,
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  doctorResponseSchema,
  healthResponseSchema,
  idempotencyHeadersSchema,
  listThreadsQuerySchema,
  listThreadsResponseSchema,
  mutationAcceptedResponseSchema,
  runPathParametersSchema,
  runStatusResponseSchema,
  sendMessageRequestSchema,
  threadDetailResponseSchema,
  threadPathParametersSchema,
} from "./schemas.js";

export interface CreateApiServerOptions {
  readonly config: AppConfig;
  readonly service: ProxyService;
  readonly logger?: FastifyBaseLogger;
}

function parse<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ProxyServiceError(
        "invalid_request",
        400,
        "Request validation failed",
        { issues: error.issues },
      );
    }
    throw error;
  }
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function authorize(request: FastifyRequest, expectedToken: string): void {
  const authorization = request.headers.authorization;
  if (
    authorization === undefined ||
    !authorization.startsWith("Bearer ") ||
    !tokenMatches(authorization.slice("Bearer ".length), expectedToken)
  ) {
    throw new ProxyServiceError(
      "unauthorized",
      401,
      "A valid bearer token is required",
    );
  }
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const parsed = parse(idempotencyHeadersSchema, {
    "idempotency-key": request.headers["idempotency-key"],
  });
  return parsed["idempotency-key"];
}

function sendError(
  reply: FastifyReply,
  error: ProxyServiceError,
): FastifyReply {
  if (error.statusCode === 401) {
    reply.header("www-authenticate", "Bearer");
  }
  const response = apiErrorResponseSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
  return reply.status(error.statusCode).send(response);
}

function requireSuccessfulMutation(result: MutationResult): void {
  if (!result.completed || result.run.state === "succeeded") {
    return;
  }

  const parsedCode = apiErrorCodeSchema.safeParse(result.run.errorCode);
  const code = parsedCode.success ? parsedCode.data : "unexpected_state";
  const statusCode =
    result.run.state === "timed_out"
      ? 504
      : result.run.state === "needs_attention"
        ? 409
        : result.run.state === "cancelled"
          ? 409
          : 502;
  throw new ProxyServiceError(
    code,
    statusCode,
    result.run.errorMessage ?? `Run ended in state '${result.run.state}'`,
    { runId: result.run.id, runState: result.run.state },
  );
}

export function createApiServer(
  options: CreateApiServerOptions,
): FastifyInstance {
  const fastifyOptions =
    options.logger === undefined
      ? { logger: false as const }
      : { loggerInstance: options.logger };
  const app = Fastify(fastifyOptions);

  app.addHook("onRequest", (request) => {
    const path = request.url.split("?", 1)[0];
    if (path !== "/v1/health" && options.config.server.requireApiToken) {
      authorize(request, options.config.server.apiToken);
    }
    return Promise.resolve();
  });

  app.get("/v1/health", () =>
    Promise.resolve(
      healthResponseSchema.parse({ status: "ok", version: APP_VERSION }),
    ),
  );

  app.get("/v1/browser/status", async () =>
    browserStatusResponseSchema.parse(await options.service.getBrowserStatus()),
  );

  app.get("/v1/doctor", async () =>
    doctorResponseSchema.parse(await options.service.getDoctorReport()),
  );

  app.get("/v1/threads", (request) => {
    const query = parse(listThreadsQuerySchema, request.query);
    return Promise.resolve(
      listThreadsResponseSchema.parse(
        options.service.listThreads(query.include_deleted),
      ),
    );
  });

  app.post("/v1/threads", async (request, reply) => {
    const body = parse(createThreadRequestSchema, request.body);
    const result = await options.service.createThread({
      name: body.name,
      message: body.message,
      ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      wait: body.wait,
      idempotencyKey: idempotencyKey(request),
    });
    requireSuccessfulMutation(result);
    reply.status(result.completed ? 201 : 202);
    return mutationAcceptedResponseSchema.parse({
      run: result.run,
      thread: result.thread,
    });
  });

  app.post("/v1/threads/:name/messages", async (request, reply) => {
    const parameters = parse(threadPathParametersSchema, request.params);
    const body = parse(sendMessageRequestSchema, request.body);
    const result = await options.service.sendMessage({
      name: parameters.name,
      message: body.message,
      ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      wait: body.wait,
      idempotencyKey: idempotencyKey(request),
    });
    requireSuccessfulMutation(result);
    reply.status(result.completed ? 200 : 202);
    return mutationAcceptedResponseSchema.parse({
      run: result.run,
      thread: result.thread,
    });
  });

  app.get("/v1/threads/:name", (request) => {
    const parameters = parse(threadPathParametersSchema, request.params);
    return Promise.resolve(
      threadDetailResponseSchema.parse(options.service.getThread(parameters.name)),
    );
  });

  app.delete("/v1/threads/:name", async (request, reply) => {
    const parameters = parse(threadPathParametersSchema, request.params);
    const body = parse(deleteThreadRequestSchema, request.body ?? {});
    const result = await options.service.deleteThread({
      name: parameters.name,
      deleteRemote: body.delete_remote,
      wait: body.wait,
      idempotencyKey: idempotencyKey(request),
    });
    requireSuccessfulMutation(result);
    reply.status(result.completed ? 200 : 202);
    return mutationAcceptedResponseSchema.parse({
      run: result.run,
      thread: result.thread,
    });
  });

  app.get("/v1/runs/:run_id", (request) => {
    const parameters = parse(runPathParametersSchema, request.params);
    return Promise.resolve(
      runStatusResponseSchema.parse(options.service.getRun(parameters.run_id)),
    );
  });

  app.setNotFoundHandler((_request, reply) =>
    sendError(
      reply,
      new ProxyServiceError("invalid_request", 404, "API route was not found"),
    ),
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProxyServiceError) {
      return sendError(reply, error);
    }

    app.log.error({ error }, "unhandled API error");
    return sendError(
      reply,
      new ProxyServiceError(
        "unexpected_state",
        500,
        "The server encountered an unexpected error",
      ),
    );
  });

  return app;
}
