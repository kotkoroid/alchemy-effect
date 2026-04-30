import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { destroy, test } from "@/Test/Vitest";
import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "create, update, delete vpc service",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    const { tunnel, service } = yield* test.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        const service = yield* Cloudflare.VpcService("VpcSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
        return { tunnel, service };
      }),
    );

    expect(service.serviceId).toBeDefined();
    expect(service.serviceType).toEqual("http");
    expect(service.httpPort).toEqual(8080);
    expect(service.host).toMatchObject({
      hostname: "localhost",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    });

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetched.serviceId).toEqual(service.serviceId);
    expect(fetched.httpPort).toEqual(8080);

    const updated = yield* test.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("VpcSvc", {
          httpPort: 3000,
          httpsPort: 3001,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(updated.serviceId).toEqual(service.serviceId);
    expect(updated.httpPort).toEqual(3000);
    expect(updated.httpsPort).toEqual(3001);

    const fetchedUpdated = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetchedUpdated.httpPort).toEqual(3000);
    expect(fetchedUpdated.httpsPort).toEqual(3001);

    yield* destroy();

    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const waitForServiceToBeDeleted = Effect.fn(function* (
  serviceId: string,
  accountId: string,
) {
  yield* connectivity
    .getDirectoryService({ accountId, serviceId })
    .pipe(
      Effect.flatMap(() => Effect.fail(new VpcServiceStillExists())),
      Effect.retry({
        while: (e): e is VpcServiceStillExists =>
          e instanceof VpcServiceStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catch(() => Effect.void),
    );
});

class VpcServiceStillExists extends Data.TaggedError(
  "VpcServiceStillExists",
) {}
