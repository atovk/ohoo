import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSession,
  listProviders,
  observeSession,
  sendTurn,
} from "../server/paseo.mjs";

test("Paseo rejects an invalid workspace or empty message before connecting", async () => {
  await assert.rejects(listProviders("relative/workspace"), {
    code: "invalid_cwd",
  });
  await assert.rejects(sendTurn("unused", " "), { code: "invalid_turn" });
});

// Opt in explicitly: this test opens a fresh, retained agent on the selected
// personal daemon and invokes its real provider. It never enumerates agents.
test(
  "a Paseo turn is recovered by its own client message ID after reconnecting",
  {
    skip: process.env.OHOO_TEST_LIVE_PASEO !== "1",
    timeout: 210_000,
  },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ohoo-paseo-live-"));
    const provider = process.env.OHOO_TEST_PROVIDER || "codex";
    const discovered = (await listProviders(cwd)).find(
      (p) => p.id === provider && p.available,
    );
    assert.ok(
      discovered,
      "The requested live test provider must be available.",
    );
    const model =
      process.env.OHOO_TEST_MODEL ||
      discovered.models.find((m) => m.isDefault)?.id ||
      discovered.models[0].id;
    const input = {
      cwd,
      provider,
      model,
      idempotencyKey: randomUUID(),
      instructions:
        "Memory check. Reply literally to each user request. Do not call tools or read files.",
    };
    const created = await createSession(input);
    t.diagnostic("Paseo verification agent: " + created.agentId);
    const again = await createSession(input);
    assert.equal(again.agentId, created.agentId);
    assert.equal(again.workspaceId, created.workspaceId);

    const marker = "orchid-" + randomUUID().slice(0, 8);
    const firstId = randomUUID();
    const first = await sendTurn(
      created.agentId,
      "Remember " + marker + " for the next turn. Reply only ACK.",
      {
        messageId: firstId,
        timeoutMs: 60_000,
      },
    );
    assert.equal(first.status, "idle");
    assert.equal(first.text.trim(), "ACK");
    const question =
      "Reply with only the verification word starting with orchid from my previous message.";
    const secondId = randomUUID();
    const eventTypes = [];
    const second = await sendTurn(created.agentId, question, {
      messageId: secondId,
      timeoutMs: 60_000,
      onEvent: (event) => eventTypes.push(event.type),
    });
    assert.equal(second.status, "idle");
    assert.equal(second.text.trim(), marker);
    assert.notEqual(first.turnId, second.turnId);
    assert.deepEqual(eventTypes, ["accepted", "status", "assistant"]);
    assert.equal(
      (await observeSession(created.agentId, { messageId: firstId })).text,
      first.text,
    );
    assert.equal(
      (await observeSession(created.agentId, { messageId: secondId })).text,
      second.text,
    );
    assert.equal(
      (await sendTurn(created.agentId, question, { messageId: secondId }))
        .turnId,
      second.turnId,
    );
    await assert.rejects(
      sendTurn(created.agentId, "Another request.", { messageId: secondId }),
      { code: "turn_conflict" },
    );
    const missing = await observeSession(created.agentId, {
      messageId: randomUUID(),
    });
    assert.equal(missing.status, "unknown");
    assert.equal(missing.text, "");
  },
);
