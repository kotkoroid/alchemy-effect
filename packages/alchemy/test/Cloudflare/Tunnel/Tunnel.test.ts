import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { destroy, test } from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test(
  "create and delete tunnel with default props",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    const tunnel = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("DefaultTunnel");
      }),
    );

    expect(tunnel.tunnelId).toBeDefined();
    expect(tunnel.tunnelName).toBeDefined();
    expect(tunnel.configSrc).toEqual("cloudflare");
    expect(Redacted.value(tunnel.token).length).toBeGreaterThan(0);

    const actualTunnel = yield* zeroTrust.getTunnelCloudflared({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(actualTunnel.id).toEqual(tunnel.tunnelId);
    expect(actualTunnel.name).toEqual(tunnel.tunnelName);

    yield* destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "create, update, delete tunnel with ingress",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    const tunnel = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("WebTunnel", {
          ingress: [
            { hostname: "test.example.com", service: "http://localhost:8080" },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(tunnel.tunnelId).toBeDefined();

    const config = yield* zeroTrust.getTunnelCloudflaredConfiguration({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(config.config?.ingress?.length).toEqual(2);
    expect(config.config?.ingress?.[0].hostname).toEqual("test.example.com");
    expect(config.config?.ingress?.[0].service).toEqual(
      "http://localhost:8080",
    );

    // Update with new ingress rules
    const updated = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("WebTunnel", {
          ingress: [
            { hostname: "app.example.com", service: "http://localhost:3000" },
            {
              hostname: "api.example.com",
              service: "http://localhost:8080",
              originRequest: {
                httpHostHeader: "api.internal",
                connectTimeout: 30,
              },
            },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(updated.tunnelId).toEqual(tunnel.tunnelId);

    const updatedConfig = yield* zeroTrust.getTunnelCloudflaredConfiguration({
      accountId,
      tunnelId: tunnel.tunnelId,
    });
    expect(updatedConfig.config?.ingress?.length).toEqual(3);
    expect(updatedConfig.config?.ingress?.[1].originRequest).toMatchObject({
      httpHostHeader: "api.internal",
      connectTimeout: 30,
    });

    yield* destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

test(
  "local configuration mode skips configuration",
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* destroy();

    const tunnel = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Tunnel("LocalTunnel", {
          configSrc: "local",
          ingress: [
            { hostname: "test.example.com", service: "http://localhost:3000" },
            { service: "http_status:404" },
          ],
          adopt: true,
        });
      }),
    );

    expect(tunnel.configSrc).toEqual("local");

    yield* destroy();

    yield* waitForTunnelToBeDeleted(tunnel.tunnelId, accountId);
  }).pipe(Effect.provide(Cloudflare.providers()), logLevel),
);

const waitForTunnelToBeDeleted = Effect.fn(function* (
  tunnelId: string,
  accountId: string,
) {
  yield* zeroTrust.listTunnels
    .items({ accountId, isDeleted: false, tunTypes: ["cfd_tunnel"] })
    .pipe(
      Stream.filter((t) => t.id === tunnelId),
      Stream.runHead,
      Effect.flatMap((option) =>
        Option.isSome(option)
          ? Effect.fail(new TunnelStillExists())
          : Effect.void,
      ),
      Effect.retry({
        while: (e): e is TunnelStillExists => e instanceof TunnelStillExists,
        schedule: Schedule.exponential(100),
      }),
    );
});

class TunnelStillExists extends Data.TaggedError("TunnelStillExists") {}
