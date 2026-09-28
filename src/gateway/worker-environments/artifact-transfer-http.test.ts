import { createHash } from "node:crypto";
import type { ReadStream } from "node:fs";
import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createGatewayAuthRateLimiter, type AuthRateLimiter } from "../auth-rate-limit.js";
import { createArtifactTransferHttpCallback } from "./artifact-transfer-http.js";
import {
  ArtifactTransferBusyError,
  createArtifactTransferService,
} from "./artifact-transfer-service.js";
import { handleWorkerBootstrapArtifactTransferHttpRequest } from "./worker-bootstrap-artifact-transfer-http.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

// Exercise real HTTP response/stream completion without binding a listener.
class ResponseSocket extends Socket {
  readonly chunks: Buffer[] = [];

  constructor(private readonly writeError?: Error) {
    super();
  }

  override _read() {
    // This sink has no peer or inbound bytes.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.chunks.push(Buffer.from(chunk));
    callback(this.writeError);
  }

  override _writev(writes: Array<{ chunk: Buffer }>, callback: (error?: Error) => void) {
    this.chunks.push(...writes.map(({ chunk }) => Buffer.from(chunk)));
    callback(this.writeError);
  }
}

function createResponse(writeError?: Error) {
  const socket = new ResponseSocket(writeError);
  const socketErrors = vi.fn<(error: Error) => void>();
  socket.on("error", socketErrors);
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);
  res.assignSocket(socket);
  return { socket, socketErrors, req, res };
}

describe("artifact transfer response settlement", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const contents = "source-runtime";
  let service: ReturnType<typeof createWorkerBootstrapArtifactTransferService>;
  let artifact: { tarballPath: string; tarballSha256: string; tarballBytes: number };
  let token: string;
  let expiresAtMs: number;
  let now: number;
  let authorized: boolean;
  let owner: AbortController;
  let rateLimiter: AuthRateLimiter | undefined;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    now = 1_000;
    authorized = true;
    owner = new AbortController();
    service = createWorkerBootstrapArtifactTransferService({ now: () => now });
    artifact = {
      tarballPath: path.join(tempDirs.make("openclaw-artifact-response-"), "runtime.tgz"),
      tarballSha256: createHash("sha256").update(contents).digest("hex"),
      tarballBytes: Buffer.byteLength(contents),
    };
    await fs.writeFile(artifact.tarballPath, contents);
    ({ token, expiresAtMs } = service.prepare({
      artifact,
      isAuthorized: () => authorized,
      signal: owner.signal,
    }));
  });

  afterEach(() => {
    service.closeAll();
    rateLimiter?.dispose();
    rateLimiter = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function serve(writeError?: Error, artifactKey = artifact.tarballSha256) {
    const { socket, req, res } = createResponse(writeError);
    req.method = "GET";
    req.url = `/__openclaw__/worker-bootstrap/artifacts/${artifactKey}`;
    req.headers.authorization = `Bearer ${token}`;
    try {
      await handleWorkerBootstrapArtifactTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback: createArtifactTransferHttpCallback(service),
        rateLimiter,
      });
      return { res, wire: Buffer.concat(socket.chunks).toString("utf8") };
    } finally {
      socket.destroy();
    }
  }

  it("counts interrupted serves and keeps retries exclusive through descriptor settlement", async () => {
    rateLimiter = createGatewayAuthRateLimiter(
      { maxAttempts: 1, exemptLoopback: false, pruneIntervalMs: 0 },
      { scheduler: createTestGatewayScheduler() },
    );
    const closing = createDeferredCore();
    const release = createDeferredCore();
    const open = service.openFile.bind(service);
    vi.spyOn(service, "openFile").mockImplementationOnce(async (authorization) => {
      const file = await open(authorization);
      if (!file) {
        throw new Error("Expected an authorized artifact");
      }
      const close = file.handle.close.bind(file.handle);
      vi.spyOn(file.handle, "close").mockImplementationOnce(async () => {
        closing.resolve();
        await release.promise;
        await close();
      });
      return file;
    });
    const interrupted = serve(new Error("synthetic connection reset"));
    try {
      await closing.promise;
      expect((await serve()).res.statusCode).toBe(503);
    } finally {
      release.resolve();
      await interrupted;
    }
    expect((await interrupted).res.writableFinished).toBe(false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const completed = await serve();
      expect(completed.res.statusCode).toBe(200);
      expect(completed.res.writableFinished).toBe(true);
      expect(completed.wire.endsWith(contents)).toBe(true);
    }
    expect((await serve()).res.statusCode).toBe(404);
  });

  it("allows three completed serves for buffering proxies, then rejects the token", async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const completed = await serve();
      expect(completed.res.statusCode).toBe(200);
      expect(completed.res.writableFinished).toBe(true);
      expect(completed.wire.endsWith(contents)).toBe(true);
    }
    expect((await serve()).res.statusCode).toBe(404);
  });

  it("fences stale attempts and retains the original retry deadline", async () => {
    const request = { token, artifactKey: artifact.tarballSha256 };
    const first = service.authorize(request)!;
    expect(() => service.authorize(request)).toThrow(ArtifactTransferBusyError);
    now = expiresAtMs - 1;
    service.finish(first);
    expect(service.authorizationSignal(first).aborted).toBe(true);
    const replacement = service.authorize(request)!;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(first);
    service.finish(first);
    service.revoke(first);
    await expect(service.openFile(first)).resolves.toBeNull();
    expect(service.isAuthorizationCurrent(replacement)).toBe(true);
    service.finish(replacement);
    now = expiresAtMs;
    expect(service.authorize(request)).toBeUndefined();
    now = 1_000;
    expect(service.authorize(request)).toBeUndefined();
  });

  it.each(["owner", "expiry", "signal"] as const)(
    "keeps busy artifact identity opaque and rejects %s closure",
    async (closure) => {
      service.authorize({ token, artifactKey: artifact.tarballSha256 });
      expect((await serve(undefined, "0".repeat(64))).res.statusCode).toBe(404);
      expect((await serve()).res.statusCode).toBe(503);
      if (closure === "owner") {
        authorized = false;
      } else if (closure === "expiry") {
        now = expiresAtMs;
      } else {
        owner.abort();
      }
      expect((await serve()).res.statusCode).toBe(404);
    },
  );

  it.each(["owner", "signal", "revoke", "shutdown"] as const)(
    "never reopens an interrupted transfer after %s closure",
    (closure) => {
      const request = { token, artifactKey: artifact.tarballSha256 };
      const admission = service.authorize(request)!;
      if (closure === "owner") {
        authorized = false;
      } else if (closure === "signal") {
        owner.abort();
      } else if (closure === "revoke") {
        service.revoke(token);
      } else {
        service.closeAll();
      }
      service.finish(admission);
      expect(service.authorizationSignal(admission).aborted).toBe(true);
      authorized = true;
      expect(service.authorize(request)).toBeUndefined();
    },
  );
});

describe("artifact transfer interruption observations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const services: Array<ReturnType<typeof createArtifactTransferService>> = [];
  const sockets: ResponseSocket[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    for (const service of services.splice(0)) {
      service.closeAll();
    }
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function prepare(onProgress?: (bytes: number) => void, maxServes: 1 | 3 = 1) {
    const tarballPath = path.join(tempDirs.make("openclaw-transfer-interruption-"), "bundle.tgz");
    await fs.writeFile(tarballPath, "bundle");
    const artifactKey = "a".repeat(64);
    const owner = new AbortController();
    let now = 1_000;
    let authorized = true;
    let authorityError: Error | undefined;
    const service = createArtifactTransferService({
      now: () => now,
      generateToken: () => "X".repeat(43),
    });
    services.push(service);
    const progress = vi.fn<(bytes: number) => void>();
    const interrupted = vi.fn<(bytes: number, reason: string) => void>();
    const prepared = service.prepare({
      artifact: { tarballPath, tarballBytes: 6, tarballSha256: "b".repeat(64) },
      artifactKey,
      ttlMs: 1_000,
      maxServes,
      signal: owner.signal,
      isAuthorized: () => {
        if (authorityError) {
          throw authorityError;
        }
        return authorized;
      },
      onProgress: (bytes) => {
        progress(bytes);
        onProgress?.(bytes);
      },
      onInterrupted: interrupted,
    });
    const openFile = service.openFile.bind(service);
    let stream: ReadStream | undefined;
    vi.spyOn(service, "openFile").mockImplementation(async (capability) => {
      const file = await openFile(capability);
      if (file) {
        const createReadStream = file.handle.createReadStream.bind(file.handle);
        vi.spyOn(file.handle, "createReadStream").mockImplementation((options) => {
          stream = createReadStream({ ...options, highWaterMark: 2 });
          return stream;
        });
      }
      return file;
    });
    let response = createResponse();
    sockets.push(response.socket);
    const callback = createArtifactTransferHttpCallback(service);
    return {
      service,
      owner,
      get socket() {
        return response.socket;
      },
      get socketErrors() {
        return response.socketErrors;
      },
      get res() {
        return response.res;
      },
      prepared,
      artifactKey,
      tarballPath,
      progress,
      interrupted,
      failStream: (error: Error) => {
        if (!stream) {
          throw new Error("fixture stream has not started");
        }
        stream.destroy(error);
      },
      loseAuthority: (error?: Error) => {
        authorized = false;
        authorityError = error;
      },
      expire: () => {
        now = prepared.expiresAtMs;
      },
      async run() {
        if (response.res.destroyed || response.res.writableFinished) {
          response = createResponse();
          sockets.push(response.socket);
        }
        const { req, res } = response;
        const admission = await callback({ req, res, artifactKey, bearer: prepared.token });
        if (admission.kind !== "authorized") {
          throw new Error("fixture artifact was not authorized");
        }
        await admission.handle();
      },
    };
  }

  it.each([
    "expired",
    "owner cancelled",
    "authorization lost",
    "throwing authorization",
    "released",
    "shutdown",
  ] as const)("reports partial transfer closure for %s", async (closure) => {
    const h = await prepare(() => {
      if (closure === "expired") {
        h.expire();
      } else if (closure === "owner cancelled") {
        h.owner.abort(new Error("private cancellation detail"));
      } else if (closure === "authorization lost" || closure === "throwing authorization") {
        h.loseAuthority(
          closure === "throwing authorization" ? new Error("private error") : undefined,
        );
      } else if (closure === "released") {
        h.service.revoke(h.prepared.token);
      } else {
        h.service.closeAll();
      }
    });
    await h.run();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(
      2,
      `authority closed (${closure === "throwing authorization" ? "authorization lost" : closure})`,
    );
    expect(h.socketErrors).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "ABORT_ERR" }),
    );
    expect(
      h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey }),
    ).toBeUndefined();
  });

  it("keeps the first closure cause when release follows owner cancellation", async () => {
    const h = await prepare(() => {
      h.owner.abort();
      h.service.revoke(h.prepared.token);
      h.service.closeAll();
    });
    await h.run();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(2, "authority closed (owner cancelled)");
    expect(h.socketErrors).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "ABORT_ERR" }),
    );
  });

  it("records timer expiry independently of a later owner cancellation", async () => {
    const h = await prepare();
    const admission = h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey });
    expect(admission).toBeDefined();
    await vi.advanceTimersByTimeAsync(1_000);
    h.owner.abort();
    h.service.revoke(admission!);
    expect(admission?.capability.revocationReason).toBe("expired");
    expect(h.service.authorizationSignal(admission!).aborted).toBe(true);
  });

  it("reports a partial client disconnect once and isolates a throwing observer", async () => {
    const h = await prepare(() => h.socket.destroy());
    h.interrupted.mockImplementation(() => {
      throw new Error("observer unavailable");
    });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(2, "client disconnected");
    expect(h.socketErrors).not.toHaveBeenCalled();
    expect(
      h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey }),
    ).toBeUndefined();
  });

  it("does not report an interruption after the complete response", async () => {
    const h = await prepare();
    await h.run();
    h.socket.destroy();
    h.owner.abort();
    expect(h.progress.mock.calls.flat()).toEqual([2, 4, 6]);
    expect(h.res.writableFinished).toBe(true);
    expect(h.interrupted).not.toHaveBeenCalled();
    expect(h.socketErrors).not.toHaveBeenCalled();
  });

  it("retains observers across interrupted and completed retries with per-serve byte counts", async () => {
    let firstServe = true;
    const h = await prepare((bytes) => {
      if (firstServe && bytes === 4) {
        firstServe = false;
        h.failStream(new Error("synthetic read failure"));
      }
    }, 3);
    await h.run();
    expect(h.interrupted).toHaveBeenCalledExactlyOnceWith(
      4,
      "stream error (synthetic read failure)",
    );
    expect(h.res.writableFinished).toBe(false);
    await h.run();
    expect(h.res.writableFinished).toBe(true);
    await h.run();
    expect(h.res.writableFinished).toBe(true);
    expect(h.progress.mock.calls.flat()).toEqual([2, 4, 2, 4, 6, 2, 4, 6]);
    expect(h.interrupted).toHaveBeenCalledOnce();
    expect(
      h.service.authorize({ token: h.prepared.token, artifactKey: h.artifactKey }),
    ).toBeUndefined();
  });

  it("keeps the stream error cause bounded and free of paths and bearers", async () => {
    const h = await prepare(() => {
      h.failStream(
        new Error(
          `read failed: ${h.tarballPath}; bearer=${h.prepared.token}; ` +
            "unix=/private/other/runtime.tgz win=C:\\private\\other\\runtime.tgz " +
            'quoted="/private/path with spaces/runtime.tgz" url=https://private.test/bundle ' +
            'relative=../private/runtime.tgz bare=private/runtime.tgz quotedRelative="private dir/runtime.tgz" ' +
            `\n${"terminal diagnostic ".repeat(200)}`,
        ),
      );
    });
    await h.run();
    expect(h.interrupted).toHaveBeenCalledOnce();
    expect(h.socketErrors).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining("read failed:") }),
    );
    const [bytes, reason] = h.interrupted.mock.calls[0]!;
    expect(bytes).toBe(2);
    expect(reason).toContain("stream error (read failed:");
    expect(reason).not.toContain(h.prepared.token);
    expect(reason).not.toContain(h.tarballPath);
    expect(reason).not.toContain("private");
    expect(reason).not.toContain("runtime.tgz");
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThanOrEqual(256);
  });
});
