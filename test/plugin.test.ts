import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

describe("plugin factory (fake host, no Boat calls)", () => {
  it("registers the boat machine provider and reports setup-required until configured", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
    await plugin(bb);
    assert.ok(harness.needsConfigurationMessages.some((m: string) => /Boat API key/.test(m)));
    const regs = harness.registrations as unknown as {
      machineProviders: Map<string, { availability(): Promise<{ status: string }>; create(c: unknown): Promise<{ status: string; message?: string }> }>;
      };
    const provider = regs.machineProviders.get("boat");
    assert.ok(provider, "boat provider registered");
    assert.equal((await provider.availability()).status, "setup-required");
    const res = await provider.create({
      inputs: null,
      key: "k",
      attempt: 1,
      checkpoint: async () => {},
      report: { step() {}, log() {} },
      signal: new AbortController().signal,
    });
    assert.equal(res.status, "failed");
    assert.match(res.message ?? "", /Boat API key/);
    await harness.behavior.runSchedule("boat-lifecycle"); // unconfigured: returns before any Boat call
    await harness.lifecycle.dispose();
  });
});
