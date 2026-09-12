import { describe, expect, it } from "vitest";
import { updateEconomy, updateGrowth } from "../src/city";
import { applyCommand, createWorld } from "../src/simulation";
import { parseWorld, serializeWorld } from "../src/persistence";

describe("manual grants", () => {
  it("keeps only one construction installment and rejects duplicate claims", () => {
    const w = createWorld();
    w.time = 7200;
    updateEconomy(w, 7200);
    expect(w.economy.cash).toBe(1900);
    expect(w.economy.pendingGrant).toBe(280);
    expect(w.economy.subsidy).toBe(0);
    expect(applyCommand(w, { type: "claim-grant" }).ok).toBe(true);
    expect(w.economy.cash).toBe(2180);
    expect(w.economy.subsidy).toBe(280);
    expect(applyCommand(w, { type: "claim-grant" }).ok).toBe(false);
    updateEconomy(w, 1);
    expect(w.economy.cash).toBe(2180);
    expect(w.economy.pendingGrant).toBe(0);
  });

  it("preserves pending grants through saves and accepts older saves", () => {
    const w = createWorld();
    expect(() => parseWorld(serializeWorld(w))).not.toThrow();
    w.time = w.growth.nextAt;
    updateGrowth(w);
    updateEconomy(w, w.time);
    const loaded = parseWorld(serializeWorld(w));
    expect(loaded.economy.cash).toBe(1900);
    expect(loaded.economy.pendingGrowthGrant).toBe(900);
    applyCommand(loaded, { type: "claim-grant" });
    expect(loaded.economy.cash).toBe(3080);
    expect(loaded.economy.pendingGrowthGrant).toBe(0);
  });

  it("does not offer construction grants above the balance threshold", () => {
    const w = createWorld();
    w.economy.cash = 3000;
    w.time = 1800;
    updateEconomy(w, 1800);
    expect(w.economy.pendingGrant ?? 0).toBe(0);
    expect(applyCommand(w, { type: "claim-grant" }).ok).toBe(false);
  });
});
