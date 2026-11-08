import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const cookieName = "ohoo_local_session";
export const cookieAge = 7 * 86400;
export function ownerKey(data) {
  const file = path.join(data, "owner.key");
  try {
    writeFileSync(file, randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return readFileSync(file, "utf8").trim();
}
export function createAuth(data) {
  const keyHash = Buffer.from(digest(ownerKey(data)), "hex");
  const db = new DatabaseSync(path.join(data, "sessions.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)",
  );
  db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
  return {
    matchesOwner(token) {
      return (
        typeof token === "string" &&
        timingSafeEqual(keyHash, Buffer.from(digest(token), "hex"))
      );
    },
    issue(id) {
      const token = randomBytes(32).toString("base64url");
      db.prepare(
        "INSERT INTO sessions (hash,user_id,expires) VALUES (?,?,?)",
      ).run(digest(token), id, Date.now() + cookieAge * 1000);
      return token;
    },
    userId(token) {
      return (
        token &&
        db
          .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires>?")
          .get(digest(token), Date.now())?.user_id
      );
    },
    revoke(token) {
      if (token)
        db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(token));
    },
    close() {
      db.close();
    },
  };
}
