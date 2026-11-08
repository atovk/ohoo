import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class StoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new StoreError(status, code, message);
}
const conflict = (message) => fail(409, "conflict", message);
const invalid = (message) => fail(400, "invalid_input", message);
const forbidden = () => fail(403, "forbidden", "当前账号无权执行此操作。");
const now = () => new Date().toISOString();
const digest = (value) => createHash("sha256").update(value).digest("hex");

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(label + "格式错误。");
  return value;
}

function requiredText(value, label, max = 255) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    invalid(label + "为空或过长。");
  return value.trim();
}

function optionalText(value, label, max = 2048) {
  if (value === undefined || value === null || value === "") return "";
  return requiredText(value, label, max);
}

function strings(value, label, max = 64) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max)
    invalid(label + "格式错误。");
  return [...new Set(value.map((item) => requiredText(item, label)))];
}

// A retried command must have exactly the same meaning, even if JSON keys arrive in a different order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

const artifactSchema = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), run_id TEXT NOT NULL REFERENCES runs(id),
  from_role_id TEXT NOT NULL, to_role_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  summary TEXT NOT NULL, fields_json TEXT NOT NULL, submitted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','returned','accepted','superseded')),
  feedback TEXT, reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT,
  phase TEXT NOT NULL DEFAULT 'handoff' CHECK(phase IN ('handoff','implementation')),
  edited_by TEXT REFERENCES users(id), supersedes_revision INTEGER,
  PRIMARY KEY(id,revision), UNIQUE(run_id,from_role_id,phase,revision)
);
`;

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS single_owner ON users(role) WHERE role='owner';
CREATE TABLE IF NOT EXISTS invites (
  digest TEXT PRIMARY KEY, expires_at TEXT NOT NULL, redeemed_by TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, version INTEGER NOT NULL,
  roles_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(team_id,user_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), team_name TEXT NOT NULL,
  team_version INTEGER NOT NULL, roles_json TEXT NOT NULL, title TEXT NOT NULL,
  current_role_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','completed')),
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'handoff' CHECK(phase IN ('handoff','implementation')),
  approved_design_json TEXT
);
CREATE TABLE IF NOT EXISTS run_members (
  run_id TEXT NOT NULL REFERENCES runs(id), user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(run_id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), role_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL REFERENCES users(id), native_session_id TEXT UNIQUE,
  UNIQUE(run_id,role_id)
);
CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
  response TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY(session_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_turn ON turns(session_id) WHERE status='pending';
${artifactSchema}
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_delivery ON artifacts(run_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), actor_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, role_id TEXT NOT NULL, artifact_id TEXT, revision INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  run_id TEXT NOT NULL REFERENCES runs(id), actor_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(run_id,actor_id,request_id)
);
CREATE INDEX IF NOT EXISTS run_history ON history(run_id,seq);
CREATE INDEX IF NOT EXISTS run_artifacts ON artifacts(run_id,created_at);
`;

const jobSchema = `
CREATE TABLE IF NOT EXISTS handoff_jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), role_id TEXT NOT NULL,
  assignee_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL CHECK(trigger IN ('handoff','return','confirm_start')),
  artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','prepared','running','completed','failed','cancelled')),
  inputs_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(run_id,artifact_id,revision,trigger), FOREIGN KEY(artifact_id,revision) REFERENCES artifacts(id,revision)
);
CREATE INDEX IF NOT EXISTS handoff_status ON handoff_jobs(status);
`;

const deliverySchema = `
CREATE TABLE IF NOT EXISTS artifact_candidates (
  artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, files_json TEXT NOT NULL,
  PRIMARY KEY(artifact_id, revision), FOREIGN KEY(artifact_id,revision) REFERENCES artifacts(id,revision)
);
CREATE TABLE IF NOT EXISTS delivery_actions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), job_id TEXT NOT NULL REFERENCES handoff_jobs(id),
  role_id TEXT NOT NULL, artifact_id TEXT NOT NULL, revision INTEGER NOT NULL, op TEXT NOT NULL,
  candidate_json TEXT NOT NULL, argv_json TEXT NOT NULL, target TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown')),
  exit_code INTEGER, output TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(job_id,op), FOREIGN KEY(artifact_id,revision) REFERENCES artifacts(id,revision)
);
CREATE TABLE IF NOT EXISTS delivery_outcomes (
  job_id TEXT PRIMARY KEY REFERENCES handoff_jobs(id), status TEXT NOT NULL CHECK(status IN ('routed','blocked')),
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);`;

function manifest(value) {
  if (!Array.isArray(value) || !value.length || value.length > 128)
    invalid("候选文件清单应列出 1 至 128 个相对文件。");
  const paths = value.map((file) => {
    if (
      typeof file !== "string" ||
      file.length > 1024 ||
      file.includes("\u0000") ||
      file.includes("\\") ||
      /^[a-z]:/i.test(file) ||
      file
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    )
      invalid("候选清单包含不安全的路径。");
    return file;
  });
  if (new Set(paths).size !== paths.length) invalid("候选清单中的路径重复。");
  return paths.sort();
}

function command(value) {
  if (!Array.isArray(value) || !value.length || value.length > 128)
    invalid("命令应填写为程序和参数的数组。");
  return value.map((arg, index) => {
    if (
      typeof arg !== "string" ||
      arg.length > 8192 ||
      arg.includes("\u0000") ||
      (index === 0 && !arg.trim())
    )
      invalid("命令参数无效。");
    return arg;
  });
}

function deliveryPolicy(input) {
  if (input.delivery === undefined || input.delivery === null) return null;
  const value = object(input.delivery, "交付策略");
  if (input.kind !== "agent" || !input.autoStartOnHandoff)
    invalid("QA 和发布策略仅适用于已授权自动接手的 agent。");
  if (value.kind === "qa") {
    const maxRepairs = value.maxRepairs ?? 2;
    if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 20)
      invalid("自动返工次数需为 0 至 20 的整数。");
    return {
      kind: "qa",
      files: manifest(value.files),
      test: command(value.test),
      maxRepairs,
    };
  }
  if (value.kind === "release")
    return {
      kind: "release",
      target: requiredText(value.target, "发布目标"),
      deploy: command(value.deploy),
      verify: command(value.verify),
    };
  invalid("交付策略应为 qa 或 release。");
}

function storedRoles(json) {
  return JSON.parse(json).map((role) =>
    role.kind === "agent"
      ? { ...role, autoStartOnHandoff: role.autoStartOnHandoff ?? false }
      : { ...role, reviewMode: role.reviewMode ?? "standard" },
  );
}

function visibleRoles(roles, actor) {
  return roles.map((role) => {
    if (!role.delivery || role.assigneeId === actor) return role;
    const d = role.delivery;
    return {
      ...role,
      delivery:
        d.kind === "qa"
          ? {
              kind: "qa",
              files: [],
              test: [],
              maxRepairs: d.maxRepairs,
              canRead: false,
            }
          : {
              kind: "release",
              target: "",
              deploy: [],
              verify: [],
              canRead: false,
            },
    };
  });
}

export function createStore(
  dbPath = ":memory:",
  { ownerName = "工作区负责人" } = {},
) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(dbPath, "a", 0o600));
  }
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;",
  );
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const write = (sql, ...args) => db.prepare(sql).run(...args);
  function tx(fn, mode = "write") {
    if (db.isTransaction) return fn();
    db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  try {
    tx(() => {
      db.exec(schema);
      // SQLite cannot widen the old CHECK or replace its uniqueness constraint in place.
      if (
        !all("PRAGMA table_info(artifacts)").some(
          (column) => column.name === "phase",
        )
      ) {
        db.exec(`DROP INDEX IF EXISTS one_pending_delivery;
          DROP INDEX IF EXISTS run_artifacts;
          ALTER TABLE artifacts RENAME TO artifacts_legacy;
          ${artifactSchema}
          INSERT INTO artifacts(id,revision,run_id,from_role_id,to_role_id,title,body,summary,fields_json,
            submitted_by,created_at,status,feedback,reviewed_by,reviewed_at)
          SELECT id,revision,run_id,from_role_id,to_role_id,title,body,summary,fields_json,
            submitted_by,created_at,status,feedback,reviewed_by,reviewed_at FROM artifacts_legacy ORDER BY rowid;
          DROP TABLE artifacts_legacy;
          CREATE UNIQUE INDEX one_pending_delivery ON artifacts(run_id) WHERE status='pending';
          CREATE INDEX run_artifacts ON artifacts(run_id,created_at);`);
      }
      if (
        !all("PRAGMA table_info(runs)").some(
          (column) => column.name === "phase",
        )
      ) {
        db.exec(
          "ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'handoff' CHECK(phase IN ('handoff','implementation')); ALTER TABLE runs ADD COLUMN approved_design_json TEXT",
        );
      }
      db.exec(jobSchema);
      db.exec(deliverySchema);
      if (!one("SELECT id FROM users WHERE role='owner'")) {
        write(
          "INSERT INTO users VALUES(?,?,'owner',?)",
          randomUUID(),
          requiredText(ownerName, "负责人姓名"),
          now(),
        );
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }

  function getUser(id) {
    if (typeof id !== "string") return null;
    const row = one("SELECT id,name,role FROM users WHERE id=?", id);
    return row ? { ...row } : null;
  }
  function owner() {
    return { ...one("SELECT id,name,role FROM users WHERE role='owner'") };
  }
  function user(id) {
    return getUser(id) || fail(401, "unauthorized", "请先登录工作区。");
  }
  function requireOwner(id) {
    if (user(id).role !== "owner") forbidden();
  }
  function listMembers(id) {
    user(id);
    return all("SELECT id,name,role FROM users ORDER BY created_at,rowid").map(
      (row) => ({ ...row }),
    );
  }
  function createInvite(id, { ttlHours = 24 } = {}) {
    requireOwner(id);
    if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168)
      invalid("邀请有效期应在一周以内。");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlHours * 3600000).toISOString();
    write(
      "INSERT INTO invites(digest,expires_at) VALUES(?,?)",
      digest(token),
      expiresAt,
    );
    return { token, expiresAt };
  }
  function redeemInvite(token, body) {
    const hash = digest(requiredText(token, "邀请"));
    const name = requiredText(object(body, "成员").name, "成员姓名", 100);
    return tx(() => {
      const invite = one("SELECT * FROM invites WHERE digest=?", hash);
      if (!invite || invite.redeemed_by || invite.expires_at <= now())
        fail(410, "invalid_invite", "邀请已无效。");
      const id = randomUUID();
      write("INSERT INTO users VALUES(?,?,'member',?)", id, name, now());
      write("UPDATE invites SET redeemed_by=? WHERE digest=?", id, hash);
      return getUser(id);
    });
  }

  function teamInput(actor, dto) {
    object(dto, "团队");
    const name = requiredText(dto.name, "团队名");
    const goal = optionalText(dto.goal, "团队目标");
    const memberIds = [
      ...new Set([actor, ...strings(dto.memberIds, "成员", 256)]),
    ];
    if (memberIds.some((id) => !getUser(id)))
      invalid("团队成员必须属于本工作区。");
    if (
      !Array.isArray(dto.roles) ||
      dto.roles.length < 2 ||
      dto.roles.length > 64
    )
      invalid("流程需要 2 至 64 个顺序角色。");
    const ids = new Set();
    const roles = dto.roles.map((input, index) => {
      object(input, "角色");
      const id =
        input.id === undefined
          ? randomUUID()
          : requiredText(input.id, "角色 ID");
      if (ids.has(id)) invalid("角色 ID 重复。");
      ids.add(id);
      if (!["agent", "human"].includes(input.kind))
        invalid("角色类型应为 agent 或 human。");
      const assigneeId = requiredText(input.assigneeId, "负责成员");
      if (!memberIds.includes(assigneeId))
        invalid("角色负责人必须是团队成员。");
      const role = {
        id,
        kind: input.kind,
        assigneeId,
        name: requiredText(input.name, "角色名称"),
        duty: requiredText(input.duty, "角色职责", 4096),
        output: requiredText(input.output, "角色产物"),
        skills: strings(input.skills, "Skills"),
        clis: strings(input.clis, "CLI"),
        requiredFields: strings(input.requiredFields, "产物必填字段"),
      };
      if (
        input.autoStartOnHandoff !== undefined &&
        typeof input.autoStartOnHandoff !== "boolean"
      )
        invalid("自动交接开关应为布尔值。");
      const mode = input.reviewMode ?? "standard";
      if (!["standard", "design"].includes(mode)) invalid("未知评审模式。");
      if (
        mode === "design" &&
        (role.kind !== "human" || dto.roles[index - 1]?.kind !== "agent")
      ) {
        invalid("设计评审必须由真人负责，且上一个角色必须是开发 agent。");
      }
      const policy = deliveryPolicy(input);
      if (role.kind === "human") {
        if (input.autoStartOnHandoff) invalid("真人角色不能自动启动 agent。");
        return { ...role, reviewMode: mode };
      }
      if (
        getUser(assigneeId).role !== "owner" ||
        input.environmentId !== "local"
      ) {
        invalid("本机 agent 只能由工作区负责人绑定到 local 环境。");
      }
      return {
        ...role,
        autoStartOnHandoff: input.autoStartOnHandoff ?? false,
        ...(policy ? { delivery: policy } : {}),
        environmentId: "local",
        provider: requiredText(input.provider, "执行器"),
        model: optionalText(input.model, "模型"),
        cwd: requiredText(input.cwd, "执行目录", 4096),
      };
    });
    for (const [i, role] of roles.entries()) {
      if (
        role.delivery?.kind === "qa" &&
        (roles[i - 1]?.kind !== "agent" ||
          roles[i - 1].delivery ||
          roles[i + 1]?.delivery?.kind !== "release")
      ) {
        invalid("QA 前一棒须为开发 agent，后一棒须为带发布策略的角色。");
      }
      if (
        role.delivery?.kind === "release" &&
        (i !== roles.length - 1 || roles[i - 1]?.delivery?.kind !== "qa")
      ) {
        invalid("发布角色须紧接 QA 且为末角色。");
      }
    }
    return { name, goal, memberIds, roles };
  }
  function teamRow(actor, id) {
    user(actor);
    const row = one(
      "SELECT t.* FROM teams t JOIN team_members m ON m.team_id=t.id WHERE t.id=? AND m.user_id=?",
      id,
      actor,
    );
    if (!row) fail(404, "not_found", "找不到该团队。");
    return row;
  }
  function getTeam(actor, id) {
    return tx(() => {
      const row = teamRow(actor, id);
      return {
        id: row.id,
        name: row.name,
        goal: row.goal,
        version: row.version,
        roles: visibleRoles(storedRoles(row.roles_json), actor),
        memberIds: all(
          "SELECT user_id FROM team_members WHERE team_id=? ORDER BY rowid",
          id,
        ).map((m) => m.user_id),
        createdAt: row.created_at,
      };
    }, "read");
  }
  function listTeams(actor) {
    return tx(() => {
      user(actor);
      return all(
        "SELECT team_id FROM team_members WHERE user_id=? ORDER BY rowid",
        actor,
      ).map((m) => getTeam(actor, m.team_id));
    }, "read");
  }
  function setMembers(teamId, members) {
    write("DELETE FROM team_members WHERE team_id=?", teamId);
    for (const id of members)
      write("INSERT INTO team_members VALUES(?,?)", teamId, id);
  }
  function createTeam(actor, dto) {
    requireOwner(actor);
    return tx(() => {
      const team = teamInput(actor, dto);
      const id = randomUUID();
      write(
        "INSERT INTO teams VALUES(?,?,?,1,?,?)",
        id,
        team.name,
        team.goal,
        JSON.stringify(team.roles),
        now(),
      );
      setMembers(id, team.memberIds);
      return getTeam(actor, id);
    });
  }
  function updateTeam(actor, id, dto) {
    requireOwner(actor);
    return tx(() => {
      const old = teamRow(actor, id);
      const team = teamInput(actor, dto);
      if (
        dto.expectedVersion !== undefined &&
        old.version !== dto.expectedVersion
      )
        conflict("团队版本已变更。");
      write(
        "UPDATE teams SET name=?,goal=?,roles_json=?,version=version+1 WHERE id=?",
        team.name,
        team.goal,
        JSON.stringify(team.roles),
        id,
      );
      setMembers(id, team.memberIds);
      return getTeam(actor, id);
    });
  }

  function runRow(actor, id) {
    user(actor);
    const row = one(
      `SELECT r.* FROM runs r JOIN team_members t ON t.team_id=r.team_id
      JOIN run_members m ON m.run_id=r.id AND m.user_id=t.user_id WHERE r.id=? AND t.user_id=?`,
      id,
      actor,
    );
    if (!row) fail(404, "not_found", "找不到该运行。");
    return row;
  }
  function artifactDto(a, actor, roleMap) {
    const from = roleMap.get(a.from_role_id),
      to = roleMap.get(a.to_role_id);
    const canRead = actor === from.assigneeId || actor === to.assigneeId;
    const meta = {
      id: a.id,
      revision: a.revision,
      runId: a.run_id,
      fromRoleId: from.id,
      toRoleId: to.id,
      title: canRead ? a.title : from.output,
      status: a.status,
      phase: a.phase,
      editedBy: a.edited_by,
      supersedesRevision: a.supersedes_revision,
      submittedBy: a.submitted_by,
      createdAt: a.created_at,
      reviewedBy: a.reviewed_by,
      reviewedAt: a.reviewed_at,
      canRead,
    };
    return canRead
      ? {
          ...meta,
          candidate: candidateOf(a.id, a.revision),
          body: a.body,
          summary: a.summary,
          fields: JSON.parse(a.fields_json),
          feedback: a.feedback,
        }
      : meta;
  }
  function getRun(actor, id) {
    return tx(() => runSnapshot(actor, id), "read");
  }
  function runSnapshot(actor, id) {
    const row = runRow(actor, id);
    const roles = storedRoles(row.roles_json),
      roleMap = new Map(roles.map((role) => [role.id, role]));
    const artifacts = all(
      "SELECT * FROM artifacts WHERE run_id=? ORDER BY rowid",
      id,
    ).map((a) => artifactDto(a, actor, roleMap));
    const artifactVersions = new Map(
      artifacts.map((a) => [a.id + "/" + a.revision, a]),
    );
    const events = all(
      "SELECT seq,type,actor_id AS actorId,role_id AS roleId,artifact_id AS artifactId,revision,created_at AS createdAt FROM history WHERE run_id=? ORDER BY seq",
      id,
    );
    const history = events.map((event) => {
      const a = artifactVersions.get(event.artifactId + "/" + event.revision);
      if (!a?.canRead) return { ...event };
      return {
        ...event,
        summary: event.type === "submitted" ? a.summary : a.feedback || "",
      };
    });
    return {
      id: row.id,
      teamId: row.team_id,
      teamName: row.team_name,
      teamVersion: row.team_version,
      phase: row.phase,
      approvedDesign: row.approved_design_json
        ? JSON.parse(row.approved_design_json)
        : null,
      handoffJobs: all(
        "SELECT * FROM handoff_jobs WHERE run_id=? ORDER BY rowid",
        id,
      ).map(jobDto),
      title: row.title,
      roles: visibleRoles(roles, actor),
      currentRoleId: row.current_role_id,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      artifacts,
      ...deliveryView(row, actor, roleMap),
      history,
    };
  }
  function listRuns(actor) {
    return tx(() => {
      user(actor);
      return all(
        `SELECT r.id FROM runs r JOIN team_members t ON t.team_id=r.team_id
        JOIN run_members m ON m.run_id=r.id AND m.user_id=t.user_id WHERE t.user_id=? ORDER BY r.rowid DESC`,
        actor,
      ).map((row) => runSnapshot(actor, row.id));
    }, "read");
  }
  function record(run, actor, role, type, artId = null, revision = null) {
    write(
      "INSERT INTO history(run_id,actor_id,role_id,type,artifact_id,revision,created_at) VALUES(?,?,?,?,?,?,?)",
      run,
      actor,
      role,
      type,
      artId,
      revision,
      now(),
    );
  }
  function startRun(actor, id, dto) {
    const title = requiredText(object(dto, "运行").title, "委托标题");
    return tx(() => {
      const team = getTeam(actor, id);
      const roles = storedRoles(teamRow(actor, id).roles_json);
      const run = randomUUID(),
        first = roles[0].id;
      write(
        "INSERT INTO runs(id,team_id,team_name,team_version,roles_json,title,current_role_id,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,'active',?,?)",
        run,
        team.id,
        team.name,
        team.version,
        JSON.stringify(roles),
        title,
        first,
        actor,
        now(),
      );
      for (const member of team.memberIds)
        write("INSERT INTO run_members VALUES(?,?)", run, member);
      record(run, actor, first, "started");
      return getRun(actor, run);
    });
  }

  function assignedRole(actor, row, roleId) {
    const role = storedRoles(row.roles_json).find((r) => r.id === roleId);
    if (!role || role.assigneeId !== actor) forbidden();
    return role;
  }
  function activeRole(row, roleId) {
    if (row.status !== "active" || row.current_role_id !== roleId)
      conflict("该角色不是此运行的当前处理人。");
  }
  function sessionRow(actor, run, roleId) {
    const row = runRow(actor, run);
    const role = assignedRole(actor, row, roleId);
    if (role.kind !== "agent") invalid("真人角色没有 agent 私有会话。");
    write(
      "INSERT INTO sessions(id,run_id,role_id,assignee_id) VALUES(?,?,?,?) ON CONFLICT(run_id,role_id) DO NOTHING",
      randomUUID(),
      run,
      roleId,
      actor,
    );
    return one(
      "SELECT * FROM sessions WHERE run_id=? AND role_id=? AND assignee_id=?",
      run,
      roleId,
      actor,
    );
  }
  function jobDto(row) {
    return {
      id: row.id,
      runId: row.run_id,
      roleId: row.role_id,
      assigneeId: row.assignee_id,
      requestId: row.request_id,
      trigger: row.trigger,
      artifactId: row.artifact_id,
      revision: row.revision,
      phase: row.phase,
      status: row.status,
      inputArtifacts: JSON.parse(row.inputs_json),
      createdAt: row.created_at,
    };
  }
  function enqueue(run, role, trigger, artifact, phase) {
    const inputs = all(
      `SELECT id AS artifactId,revision FROM artifacts WHERE run_id=? AND to_role_id=?
      AND status='accepted' ORDER BY rowid`,
      run,
      role.id,
    );
    if (phase === "implementation") {
      const approved = JSON.parse(
        one("SELECT approved_design_json FROM runs WHERE id=?", run)
          .approved_design_json || "null",
      );
      if (
        approved?.roleId === role.id &&
        !inputs.some(
          (r) =>
            r.artifactId === approved.artifactId &&
            r.revision === approved.revision,
        )
      ) {
        inputs.push({
          artifactId: approved.artifactId,
          revision: approved.revision,
        });
      }
    }
    if (
      !inputs.some(
        (r) => r.artifactId === artifact.id && r.revision === artifact.revision,
      )
    ) {
      inputs.push({ artifactId: artifact.id, revision: artifact.revision });
    }
    const id = randomUUID();
    write(
      `INSERT INTO handoff_jobs(id,run_id,role_id,assignee_id,request_id,trigger,artifact_id,revision,phase,status,inputs_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`,
      id,
      run,
      role.id,
      role.assigneeId,
      "auto:" + id,
      trigger,
      artifact.id,
      artifact.revision,
      phase,
      JSON.stringify(inputs),
      now(),
    );
  }
  function listQueuedHandoffs() {
    return all(
      "SELECT * FROM handoff_jobs WHERE status='queued' ORDER BY rowid",
    ).map(jobDto);
  }
  function jobIsCurrent(job) {
    const run = one(
      `SELECT r.* FROM runs r JOIN team_members t ON t.team_id=r.team_id AND t.user_id=?
      JOIN run_members m ON m.run_id=r.id AND m.user_id=t.user_id WHERE r.id=?`,
      job.assignee_id,
      job.run_id,
    );
    if (
      !run ||
      run.status !== "active" ||
      run.current_role_id !== job.role_id ||
      run.phase !== job.phase
    )
      return false;
    const target = storedRoles(run.roles_json).find(
      (role) => role.id === job.role_id,
    );
    if (
      target?.kind !== "agent" ||
      target.assigneeId !== job.assignee_id ||
      (job.trigger !== "confirm_start" && !target.autoStartOnHandoff)
    )
      return false;
    const artifact = one(
      "SELECT * FROM artifacts WHERE id=? AND run_id=? ORDER BY revision DESC LIMIT 1",
      job.artifact_id,
      job.run_id,
    );
    if (!artifact || artifact.revision !== job.revision) return false;
    if (job.trigger === "return")
      return (
        artifact.status === "returned" && artifact.from_role_id === target.id
      );
    if (job.trigger === "confirm_start") {
      const approved = JSON.parse(run.approved_design_json || "null");
      return (
        artifact.status === "accepted" &&
        approved?.artifactId === artifact.id &&
        approved.revision === artifact.revision &&
        approved.roleId === target.id
      );
    }
    return (
      ["pending", "accepted"].includes(artifact.status) &&
      artifact.to_role_id === target.id
    );
  }
  function cancelJob(job) {
    write("UPDATE handoff_jobs SET status='cancelled' WHERE id=?", job.id);
    write(
      `UPDATE turns SET status='failed',error='工作项或授权已经变更，未派发。',completed_at=?
      WHERE session_id IN (SELECT id FROM sessions WHERE run_id=? AND role_id=?) AND request_id=? AND status='pending'`,
      now(),
      job.run_id,
      job.role_id,
      job.request_id,
    );
  }
  function preparedJob(job) {
    const session = sessionRow(job.assignee_id, job.run_id, job.role_id);
    const view = sessionDto(session);
    return {
      job: jobDto(job),
      session: view,
      turn: view.turns.find((t) => t.requestId === job.request_id),
    };
  }
  function claimHandoff(id) {
    return tx(() => {
      const job = one(
        "SELECT * FROM handoff_jobs WHERE id=? AND status='queued'",
        id,
      );
      if (!job) return null;
      if (!jobIsCurrent(job)) {
        cancelJob(job);
        return null;
      }
      if (pendingTurn(job.run_id, job.role_id)) return null;
      const session = sessionRow(job.assignee_id, job.run_id, job.role_id);
      const instructions = {
        handoff: "按本角色职责处理本次明确交付的材料并起草所需产物。",
        return: "根据退回意见修订指定版本，保留原始决定与验收条件。",
        confirm_start:
          "开发负责人已确认此版设计。按已批准的设计开始实现，并说明改动与验证结果。",
      };
      write(
        "INSERT INTO turns(session_id,request_id,text,status,created_at) VALUES(?,?,?,'pending',?)",
        session.id,
        job.request_id,
        instructions[job.trigger],
        now(),
      );
      write("UPDATE handoff_jobs SET status='prepared' WHERE id=?", id);
      return preparedJob({ ...job, status: "prepared" });
    });
  }
  function listPreparedHandoffs() {
    return tx(() => {
      const results = [];
      for (const job of all(
        "SELECT * FROM handoff_jobs WHERE status='prepared' ORDER BY rowid",
      )) {
        if (jobIsCurrent(job)) results.push(preparedJob(job));
        else cancelJob(job);
      }
      return results;
    });
  }
  function markHandoffDispatched(id) {
    return tx(() => {
      const job = one(
        "SELECT * FROM handoff_jobs WHERE id=? AND status='prepared'",
        id,
      );
      if (!job) return false;
      if (!jobIsCurrent(job)) {
        cancelJob(job);
        return false;
      }
      write("UPDATE handoff_jobs SET status='running' WHERE id=?", id);
      return true;
    });
  }
  function activeJob(run, role) {
    return one(
      "SELECT id FROM handoff_jobs WHERE run_id=? AND role_id=? AND status IN ('queued','prepared','running')",
      run,
      role,
    );
  }
  function turnDto(t) {
    return {
      requestId: t.request_id,
      text: t.text,
      status: t.status,
      handoffStatus: t.handoff_status ?? null,
      response: t.response,
      error: t.error,
      createdAt: t.created_at,
      completedAt: t.completed_at,
    };
  }
  function sessionDto(row) {
    const turns = all(
      `SELECT t.*,j.status AS handoff_status FROM turns t LEFT JOIN handoff_jobs j
        ON j.request_id=t.request_id AND j.run_id=? AND j.role_id=? WHERE t.session_id=? ORDER BY t.rowid`,
      row.run_id,
      row.role_id,
      row.id,
    ).map(turnDto);
    const messages = [];
    for (const turn of turns) {
      messages.push({
        role: "user",
        text: turn.text,
        content: turn.text,
        requestId: turn.requestId,
        createdAt: turn.createdAt,
      });
      if (turn.status === "completed")
        messages.push({
          role: "assistant",
          text: turn.response,
          content: turn.response,
          requestId: turn.requestId,
          createdAt: turn.completedAt,
        });
    }
    return {
      id: row.id,
      runId: row.run_id,
      roleId: row.role_id,
      nativeSessionId: row.native_session_id,
      turns,
      messages,
    };
  }
  function getSession(actor, run, role) {
    return tx(() => sessionDto(sessionRow(actor, run, role)));
  }
  // Used by the trusted service at startup. Pending entries need reconciliation, not automatic resend.
  function listPendingTurns() {
    return all(`SELECT s.id AS sessionId,s.native_session_id AS nativeSessionId,s.run_id AS runId,
      s.role_id AS roleId,s.assignee_id AS assigneeId,t.request_id AS requestId,t.created_at AS createdAt,j.status AS handoffStatus
      FROM sessions s JOIN turns t ON t.session_id=s.id LEFT JOIN handoff_jobs j ON j.run_id=s.run_id
      AND j.role_id=s.role_id AND j.request_id=t.request_id WHERE t.status='pending' ORDER BY t.rowid`).map(
      (row) => ({ ...row }),
    );
  }
  function bindNativeSession(actor, run, role, nativeId) {
    const id = requiredText(nativeId, "远端会话 ID");
    return tx(() => {
      const session = sessionRow(actor, run, role);
      if (session.native_session_id === id) return sessionDto(session);
      if (
        session.native_session_id ||
        one("SELECT id FROM sessions WHERE native_session_id=?", id)
      ) {
        conflict("远端会话已绑定。");
      }
      write(
        "UPDATE sessions SET native_session_id=? WHERE id=?",
        id,
        session.id,
      );
      return sessionDto({ ...session, native_session_id: id });
    });
  }
  function beginTurn(actor, run, role, dto) {
    object(dto, "消息");
    const requestId = requiredText(dto.requestId, "请求 ID");
    requiredText(dto.text, "消息", 100000);
    const text = dto.text;
    return tx(() => {
      const session = sessionRow(actor, run, role);
      const previous = one(
        "SELECT * FROM turns WHERE session_id=? AND request_id=?",
        session.id,
        requestId,
      );
      if (previous) {
        if (previous.text !== text) conflict("同一请求 ID 对应了不同消息。");
        return {
          created: false,
          turn: turnDto(previous),
          session: sessionDto(session),
        };
      }
      activeRole(runRow(actor, run), role);
      if (requestId.startsWith("auto:"))
        invalid("请求 ID 使用了保留的自动任务前缀。");
      if (activeJob(run, role)) conflict("本角色有一项自动交接任务等待完成。");
      if (
        one(
          "SELECT request_id FROM turns WHERE session_id=? AND status='pending'",
          session.id,
        )
      ) {
        conflict("已有消息在执行或等待核对。");
      }
      write(
        "INSERT INTO turns(session_id,request_id,text,status,created_at) VALUES(?,?,?,'pending',?)",
        session.id,
        requestId,
        text,
        now(),
      );
      const turn = one(
        "SELECT * FROM turns WHERE session_id=? AND request_id=?",
        session.id,
        requestId,
      );
      return {
        created: true,
        turn: turnDto(turn),
        session: sessionDto(session),
      };
    });
  }
  function endTurn(actor, run, role, requestId, status, value) {
    requiredText(requestId, "请求 ID");
    return tx(() => {
      const session = sessionRow(actor, run, role);
      const turn = one(
        "SELECT * FROM turns WHERE session_id=? AND request_id=?",
        session.id,
        requestId,
      );
      if (!turn) fail(404, "not_found", "找不到这轮消息。");
      const response = status === "completed" ? value : null,
        error = status === "failed" ? value : null;
      if (turn.status === "pending") {
        write(
          "UPDATE turns SET status=?,response=?,error=?,completed_at=? WHERE session_id=? AND request_id=?",
          status,
          response,
          error,
          now(),
          session.id,
          requestId,
        );
      } else if (
        turn.status !== status ||
        turn.response !== response ||
        turn.error !== error
      ) {
        conflict("该消息已有不同的终态。");
      }
      write(
        "UPDATE handoff_jobs SET status=? WHERE run_id=? AND role_id=? AND request_id=? AND status IN ('prepared','running')",
        status,
        run,
        role,
        requestId,
      );
      return sessionDto(session);
    });
  }
  function finishTurn(actor, run, role, id, dto) {
    const text = object(dto, "执行结果").text;
    if (typeof text !== "string" || text.length > 2000000)
      invalid("执行结果格式错误。");
    return endTurn(actor, run, role, id, "completed", text);
  }
  function failTurn(actor, run, role, id, dto) {
    return endTurn(
      actor,
      run,
      role,
      id,
      "failed",
      requiredText(object(dto, "执行错误").error, "错误说明", 12000),
    );
  }

  function receipt(actor, run, requestId, operation) {
    const id = requiredText(requestId, "请求 ID");
    const signature = digest(JSON.stringify(canonical(operation)));
    const old = one(
      "SELECT signature FROM receipts WHERE run_id=? AND actor_id=? AND request_id=?",
      run,
      actor,
      id,
    );
    if (old) {
      if (old.signature !== signature) conflict("同一请求 ID 用于不同操作。");
      return true;
    }
    write("INSERT INTO receipts VALUES(?,?,?,?)", run, actor, id, signature);
    return false;
  }
  function pendingTurn(run, role) {
    return one(
      `SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id
      WHERE s.run_id=? AND s.role_id=? AND t.status='pending'`,
      run,
      role,
    );
  }
  function fieldsFor(input, requiredFields) {
    const fields = object(input ?? {}, "产物字段");
    if (
      Object.keys(fields).length > 64 ||
      Object.values(fields).some(
        (v) => typeof v !== "string" || v.length > 10000,
      )
    ) {
      invalid("产物字段需要使用文本值。");
    }
    for (const key of requiredFields) {
      if (!Object.hasOwn(fields, key) || !fields[key].trim())
        invalid("缺少产物字段：" + key);
    }
    return fields;
  }
  function insertArtifact(a) {
    write(
      `INSERT INTO artifacts(id,revision,run_id,from_role_id,to_role_id,title,body,summary,fields_json,
      submitted_by,created_at,status,phase,edited_by,supersedes_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      a.id,
      a.revision,
      a.run_id,
      a.from_role_id,
      a.to_role_id,
      a.title,
      a.body,
      a.summary,
      a.fields_json,
      a.submitted_by,
      now(),
      a.phase,
      a.edited_by ?? null,
      a.supersedes_revision ?? null,
    );
  }
  function candidateOf(id, revision) {
    const r = one(
      "SELECT digest,files_json FROM artifact_candidates WHERE artifact_id=? AND revision=?",
      id,
      revision,
    );
    return r ? { digest: r.digest, files: JSON.parse(r.files_json) } : null;
  }
  function saveCandidate(a, candidate, paths) {
    if (!candidate || !/^[0-9a-f]{64}$/.test(candidate.digest))
      invalid("缺少服务端封存的候选摘要。");
    const files = manifest(candidate.files);
    if (JSON.stringify(files) !== JSON.stringify(paths))
      invalid("封存的候选文件与 QA 策略不一致。");
    write(
      "INSERT INTO artifact_candidates VALUES(?,?,?,?)",
      a.id,
      a.revision,
      candidate.digest,
      JSON.stringify(files),
    );
  }
  function deliveryAction(row, canRead = true) {
    const meta = {
      id: row.id,
      jobId: row.job_id,
      runId: row.run_id,
      roleId: row.role_id,
      artifactId: row.artifact_id,
      revision: row.revision,
      op: row.op,
      status: row.status,
      exitCode: row.exit_code,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      canRead,
    };
    return canRead
      ? {
          ...meta,
          candidate: JSON.parse(row.candidate_json),
          argv: JSON.parse(row.argv_json),
          target: row.target,
          output: row.output,
        }
      : meta;
  }
  function deliveryView(run, actor, roles) {
    const access = (a) =>
      actor === roles.get(a.from_role_id)?.assigneeId ||
      actor === roles.get(a.to_role_id)?.assigneeId ||
      actor === roles.get(a.role_id)?.assigneeId;
    const actions = all(
      `SELECT d.*,a.from_role_id,a.to_role_id,a.status AS artifact_status FROM delivery_actions d JOIN artifacts a
      ON d.artifact_id=a.id AND d.revision=a.revision WHERE d.run_id=? ORDER BY d.rowid`,
      run.id,
    );
    const blocks = all(
      `SELECT o.reason,o.created_at,j.role_id,j.id AS job_id,a.from_role_id,a.to_role_id,a.id,a.revision,a.status
      FROM delivery_outcomes o JOIN handoff_jobs j ON j.id=o.job_id JOIN artifacts a ON a.id=j.artifact_id AND a.revision=j.revision
      WHERE j.run_id=? AND o.status='blocked' AND NOT EXISTS(SELECT 1 FROM artifacts newer WHERE newer.id=a.id AND newer.revision>a.revision)
      ORDER BY o.rowid DESC`,
      run.id,
    );
    const awaitingReconciliation = actions.findLast(
      (a) =>
        a.role_id === run.current_role_id &&
        a.artifact_status === "pending" &&
        (a.status === "unknown" || (a.op !== "test" && a.status === "failed")),
    );
    const b =
      run.status === "active"
        ? (blocks.find(
            (x) =>
              x.role_id === run.current_role_id ||
              (x.from_role_id === run.current_role_id &&
                x.status === "returned"),
          ) ??
          (awaitingReconciliation && {
            ...awaitingReconciliation,
            id: awaitingReconciliation.artifact_id,
            created_at: awaitingReconciliation.completed_at,
            reason:
              awaitingReconciliation.status === "unknown"
                ? "命令结果未知，请先核对原环境。"
                : "发布命令失败，请核对执行回执。",
          }))
        : null;
    const deliveryBlock = b
      ? {
          jobId: b.job_id,
          roleId: b.role_id,
          artifactId: b.id,
          revision: b.revision,
          createdAt: b.created_at,
          reason: access(b) ? b.reason : "等待负责成员核对交付证据。",
          canRead: access(b),
        }
      : null;
    return {
      deliveryActions: actions.map((a) => deliveryAction(a, access(a))),
      deliveryBlock,
    };
  }
  // The HTTP adapter calls this before filesystem capture, then rechecks under saveSubmission's transaction.
  function replayedSubmission(actor, run, roleId, dto) {
    object(dto, "产物");
    return tx(() => {
      assignedRole(actor, runRow(actor, run), roleId);
      const id = requiredText(dto.requestId, "请求 ID");
      const previous = one(
        "SELECT signature FROM receipts WHERE run_id=? AND actor_id=? AND request_id=?",
        run,
        actor,
        id,
      );
      if (!previous) return null;
      if (
        previous.signature !==
        digest(JSON.stringify(canonical({ action: "submit", roleId, dto })))
      )
        conflict("同一请求 ID 用于不同操作。");
      return getRun(actor, run);
    }, "read");
  }
  // Trusted service lookup. The public run projection separately filters evidence by role and membership.
  function getDeliveryJob(id) {
    return tx(() => {
      const j = one("SELECT * FROM handoff_jobs WHERE id=?", id);
      if (!j || !jobIsCurrent(j)) return null;
      const run = runSnapshot(j.assignee_id, j.run_id);
      const role = run.roles.find((r) => r.id === j.role_id);
      const artifact = run.artifacts.find(
        (a) => a.id === j.artifact_id && a.revision === j.revision,
      );
      if (!artifact?.canRead || !artifact.candidate) return null;
      const qa = run.roles.find((r) => r.delivery?.kind === "qa");
      const release = run.roles.find((r) => r.delivery?.kind === "release");
      if (!qa || !release) return null;
      let kind;
      if (
        j.trigger === "return" &&
        j.role_id === artifact.fromRoleId &&
        artifact.toRoleId === qa.id
      )
        kind = "repair";
      else if (
        j.trigger === "handoff" &&
        artifact.status === "pending" &&
        artifact.toRoleId === role.id
      )
        kind = role.delivery?.kind;
      if (!kind) return null;
      return {
        kind,
        job: jobDto(j),
        runId: run.id,
        run,
        role,
        artifact,
        candidate: artifact.candidate,
        qaPolicy: qa.delivery,
        releasePolicy: release.delivery,
        operation: kind === "repair" ? "repair" : "settle",
      };
    }, "read");
  }
  function outcome(jobId, state, reason) {
    write(
      "INSERT INTO delivery_outcomes(job_id,status,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(job_id) DO NOTHING",
      jobId,
      state,
      reason,
      now(),
    );
  }
  function pendingRepair(run, roleId) {
    return one(
      `SELECT j.id FROM handoff_jobs j JOIN artifacts a ON a.id=j.artifact_id AND a.revision=j.revision
      JOIN artifact_candidates c ON c.artifact_id=a.id AND c.revision=a.revision
      WHERE j.run_id=? AND j.role_id=? AND j.trigger='return' AND j.status IN ('completed','failed')
      AND a.status='returned' AND NOT EXISTS(SELECT 1 FROM delivery_outcomes o WHERE o.job_id=j.id)`,
      run,
      roleId,
    );
  }
  function listDeliveryWork() {
    return tx(() => {
      const jobs =
        all(`SELECT j.id FROM handoff_jobs j WHERE j.status IN ('completed','failed')
        AND NOT EXISTS(SELECT 1 FROM delivery_outcomes o WHERE o.job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM delivery_actions d WHERE d.job_id=j.id AND d.status='running')
        ORDER BY j.rowid`);
      return jobs.map((j) => getDeliveryJob(j.id)).filter(Boolean);
    }, "read");
  }
  function blockDelivery(jobId, reason) {
    return tx(() => {
      const task = getDeliveryJob(jobId);
      if (!task) return null;
      outcome(jobId, "blocked", requiredText(reason, "阻塞原因", 12000));
      return getRun(task.job.assigneeId, task.runId);
    });
  }
  function beginDeliveryAction(jobId, op) {
    return tx(() => {
      if (!["test", "deploy", "verify"].includes(op)) invalid("未知交付动作。");
      const previous = one(
        "SELECT * FROM delivery_actions WHERE job_id=? AND op=?",
        jobId,
        op,
      );
      if (previous) return { created: false, action: deliveryAction(previous) };
      const task = getDeliveryJob(jobId);
      if (
        !task ||
        task.job.status !== "running" ||
        !one(
          `SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.run_id=? AND s.role_id=?
            AND s.native_session_id IS NOT NULL AND t.request_id=? AND t.status='pending'`,
          task.runId,
          task.role.id,
          task.job.requestId,
        ) ||
        one("SELECT 1 FROM delivery_outcomes WHERE job_id=?", jobId)
      )
        conflict("只有当前已派发的策略角色回合可以执行命令。");
      const { candidate, role, job, artifact } = task;
      if (
        (task.kind === "qa" && op !== "test") ||
        (task.kind === "release" && op === "test") ||
        task.kind === "repair"
      )
        forbidden();
      if (task.kind === "release") {
        // A release only consumes the report emitted by the preceding QA gate for this exact immutable digest.
        const passed = one(
          `SELECT d.id FROM delivery_actions d JOIN handoff_jobs qa ON qa.id=d.job_id
          JOIN delivery_outcomes o ON o.job_id=qa.id AND o.status='routed'
          JOIN artifacts original ON original.id=qa.artifact_id AND original.revision=qa.revision
          JOIN artifact_candidates c ON c.artifact_id=original.id AND c.revision=original.revision
          WHERE d.run_id=? AND d.role_id=? AND qa.role_id=? AND original.status='accepted' AND d.op='test' AND d.status='succeeded'
          AND c.digest=? AND d.id=? AND d.exit_code=0 LIMIT 1`,
          task.runId,
          artifact.fromRoleId,
          artifact.fromRoleId,
          candidate.digest,
          artifact.fields.receipt,
        );
        if (!passed) conflict("没有本运行对应制品的 QA 通过凭据。");
      }
      if (op === "verify") {
        const deployed = one(
          "SELECT * FROM delivery_actions WHERE job_id=? AND op='deploy' AND status='succeeded'",
          jobId,
        );
        if (
          !deployed ||
          JSON.parse(deployed.candidate_json).digest !== candidate.digest ||
          deployed.target !== role.delivery.target
        ) {
          conflict("只有该环境同一候选成功部署后才能验证。");
        }
      }
      const id = randomUUID(),
        target = task.kind === "release" ? role.delivery.target : "";
      write(
        `INSERT INTO delivery_actions(id,run_id,job_id,role_id,artifact_id,revision,op,candidate_json,argv_json,target,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'running',?)`,
        id,
        task.runId,
        job.id,
        role.id,
        artifact.id,
        artifact.revision,
        op,
        JSON.stringify(candidate),
        JSON.stringify(role.delivery[op]),
        target,
        now(),
      );
      return {
        created: true,
        action: deliveryAction(
          one("SELECT * FROM delivery_actions WHERE id=?", id),
        ),
      };
    });
  }
  function endAction(id, status, code, output) {
    return tx(() => {
      const a = one("SELECT * FROM delivery_actions WHERE id=?", id);
      if (!a) fail(404, "not_found", "找不到交付动作。");
      if (a.status !== "running") {
        if (a.status !== status || a.exit_code !== code || a.output !== output)
          conflict("该动作已有不同的结果。");
        return deliveryAction(a);
      }
      write(
        "UPDATE delivery_actions SET status=?,exit_code=?,output=?,completed_at=? WHERE id=?",
        status,
        code,
        output,
        now(),
        id,
      );
      return deliveryAction(
        one("SELECT * FROM delivery_actions WHERE id=?", id),
      );
    });
  }
  function finishDeliveryAction(id, receipt) {
    object(receipt, "命令回执");
    if (
      !Number.isSafeInteger(receipt.exitCode) ||
      typeof receipt.output !== "string"
    )
      invalid("回执需要实际退出码与文本输出。");
    return endAction(
      id,
      receipt.exitCode === 0 ? "succeeded" : "failed",
      receipt.exitCode,
      receipt.output.slice(-65536),
    );
  }
  function markDeliveryActionUnknown(id, reason) {
    if (typeof reason !== "string" || !reason.trim())
      invalid("请说明未知结果的原因。");
    return endAction(id, "unknown", null, reason.slice(-65536));
  }
  function recoverDeliveryActions() {
    return tx(() =>
      Number(
        write(
          `UPDATE delivery_actions SET status='unknown',output='进程重启前未取得命令回执，请核对原环境。',completed_at=?
      WHERE status='running'`,
          now(),
        ).changes,
      ),
    );
  }
  function settleDelivery(jobId) {
    return tx(() => {
      const job = one("SELECT * FROM handoff_jobs WHERE id=?", jobId);
      if (!job) fail(404, "not_found", "找不到交付任务。");
      if (one("SELECT 1 FROM delivery_outcomes WHERE job_id=?", jobId))
        return getRun(job.assignee_id, job.run_id);
      const task = getDeliveryJob(jobId);
      if (
        !task ||
        task.kind === "repair" ||
        !["completed", "failed"].includes(job.status)
      )
        conflict("当前任务尚不能根据回执推进。");
      if (job.status !== "completed")
        return blockDelivery(
          jobId,
          "角色的执行回合失败，请核对该角色的私有会话及命令证据。",
        );
      const actions = all(
        "SELECT * FROM delivery_actions WHERE job_id=?",
        jobId,
      );
      if (actions.some((a) => a.status === "running")) return task.run;
      const op = task.kind === "qa" ? "test" : "deploy";
      const first = actions.find((a) => a.op === op),
        verify = actions.find((a) => a.op === "verify");
      if (!first || first.status === "unknown")
        return blockDelivery(
          jobId,
          first
            ? "命令结果未知，请先核对原环境。"
            : "缺少当前版本真实命令回执。",
        );
      const actor = job.assignee_id,
        run = job.run_id,
        role = job.role_id,
        a = task.artifact,
        candidate = task.candidate;
      const sign = (status, feedback) =>
        write(
          `UPDATE artifacts SET status=?,feedback=?,reviewed_by=?,reviewed_at=? WHERE id=? AND revision=? AND status='pending'`,
          status,
          feedback,
          actor,
          now(),
          a.id,
          a.revision,
        );
      if (task.kind === "qa" && first.status === "failed") {
        const reason =
          "测试未通过。回执 " +
          first.id +
          "，退出码 " +
          first.exit_code +
          "。" +
          (first.output ? " 输出：" + first.output.slice(-3000) : "");
        sign("returned", reason);
        write(
          "UPDATE runs SET current_role_id=? WHERE id=?",
          a.fromRoleId,
          run,
        );
        record(run, actor, role, "returned", a.id, a.revision);
        const developer = task.run.roles.find((r) => r.id === a.fromRoleId);
        const repairs = Number(
          one(
            `SELECT count(*) AS n FROM handoff_jobs WHERE run_id=? AND trigger='return' AND artifact_id=?`,
            run,
            a.id,
          ).n,
        );
        if (
          developer.autoStartOnHandoff &&
          repairs < task.qaPolicy.maxRepairs
        ) {
          enqueue(run, developer, "return", a, job.phase);
          outcome(jobId, "routed", "附失败命令证据退回开发。");
        } else
          outcome(
            jobId,
            "blocked",
            developer.autoStartOnHandoff
              ? "已达到自动修复次数上限，请开发成员核对。"
              : "请开发成员处理测试失败的版本。",
          );
      } else if (task.kind === "qa") {
        const next =
          task.run.roles[task.run.roles.findIndex((r) => r.id === role) + 1];
        const fields = {
          candidate: candidate.digest,
          receipt: first.id,
          exitCode: "0",
          command: JSON.stringify(task.qaPolicy.test),
          候选版本: candidate.digest,
          测试证据: first.id,
          退出码: "0",
          测试命令: JSON.stringify(task.qaPolicy.test),
        };
        if (task.role.requiredFields.some((key) => !Object.hasOwn(fields, key)))
          return blockDelivery(
            jobId,
            "QA 报告缺少能由本次命令证据填写的必填字段。",
          );
        sign("accepted", "QA 命令通过。回执 " + first.id);
        record(run, actor, role, "accepted", a.id, a.revision);
        const report = {
          id: randomUUID(),
          revision: 1,
          run_id: run,
          from_role_id: role,
          to_role_id: next.id,
          title: task.role.output,
          body:
            "已验证候选 " +
            candidate.digest +
            "。测试退出码为 0，回执 " +
            first.id +
            "。",
          summary: "对 QA 签收的同一候选执行发布和验证。",
          fields_json: JSON.stringify(fields),
          submitted_by: actor,
          phase: job.phase,
        };
        insertArtifact(report);
        saveCandidate(report, candidate, task.qaPolicy.files);
        write("UPDATE runs SET current_role_id=? WHERE id=?", next.id, run);
        record(run, actor, role, "submitted", report.id, report.revision);
        enqueue(run, next, "handoff", report, job.phase);
        outcome(jobId, "routed", "QA 已签收指定版本并交付带命令证据的报告。");
      } else {
        if (first.status !== "succeeded")
          return blockDelivery(
            jobId,
            "指定候选部署失败，保留原命令回执，请核对环境。",
          );
        if (!verify || verify.status !== "succeeded")
          return blockDelivery(
            jobId,
            verify ? "上线验证失败或结果未知。" : "缺少该候选的上线验证回执。",
          );
        sign("accepted", "上线验证通过。回执 " + verify.id);
        record(run, actor, role, "accepted", a.id, a.revision);
        write("UPDATE runs SET status='completed' WHERE id=?", run);
        record(run, actor, role, "completed", a.id, a.revision);
        outcome(jobId, "routed", "候选通过指定目标发布及验证。");
      }
      return getRun(actor, run);
    });
  }
  function submitRepair(jobId, candidate) {
    return tx(() => {
      const j = one("SELECT * FROM handoff_jobs WHERE id=?", jobId);
      if (!j) fail(404, "not_found", "找不到修订任务。");
      if (one("SELECT 1 FROM delivery_outcomes WHERE job_id=?", jobId))
        return getRun(j.assignee_id, j.run_id);
      const task = getDeliveryJob(jobId);
      if (
        !task ||
        task.kind !== "repair" ||
        !task.role.autoStartOnHandoff ||
        !["completed", "failed"].includes(task.job.status)
      )
        conflict("未获授权提交此次修订。");
      if (task.job.status === "failed")
        return blockDelivery(jobId, "自动修复回合失败，请开发成员核对。");
      const a = task.artifact;
      // The candidate and its public metadata are the output. Native assistant text remains private.
      const dto = {
        requestId: "repair:" + jobId,
        title: a.title,
        body: "修订后的候选制品：" + (candidate?.digest || ""),
        summary: "依据该版本的 QA 失败回执提交修复候选，请重新测试。",
        fields: a.fields,
        baseRevision: a.revision,
      };
      saveSubmission(
        task.job.assigneeId,
        task.runId,
        task.role.id,
        dto,
        candidate,
        jobId,
      );
      outcome(jobId, "routed", "已提交同一产物的修订版。");
      return getRun(task.job.assigneeId, task.runId);
    });
  }
  function submitArtifact(actor, run, roleId, dto, candidate) {
    return saveSubmission(actor, run, roleId, dto, candidate, null);
  }

  function saveSubmission(actor, run, roleId, dto, candidate, repairJobId) {
    object(dto, "产物");
    return tx(() => {
      const row = runRow(actor, run),
        role = assignedRole(actor, row, roleId);
      if (receipt(actor, run, dto.requestId, { action: "submit", roleId, dto }))
        return getRun(actor, run);
      activeRole(row, roleId);
      if (role.delivery) conflict("交付策略节点由持久化命令回执决定结果。");
      if (!repairJobId && pendingRepair(run, roleId))
        conflict("自动修复仍在准备修订制品。");
      if (pendingTurn(run, roleId) || activeJob(run, roleId))
        conflict("先完成或核对本轮执行，再交接产物。");
      if (
        one("SELECT id FROM artifacts WHERE run_id=? AND status='pending'", run)
      )
        conflict("请先处理待签收的产物。");
      const roles = storedRoles(row.roles_json);
      const next = roles[roles.findIndex((r) => r.id === roleId) + 1];
      if (!next) conflict("末角色签收上一棒的产物即完成。");
      const implementation = row.phase === "implementation";
      const title =
        optionalText(dto.title, "产物标题") ||
        (implementation ? "实现产物" : role.output);
      requiredText(dto.body, "产物正文", 250000);
      const summary = requiredText(dto.summary, "交接摘要", 4000);
      const fields = fieldsFor(
        dto.fields,
        implementation ? [] : role.requiredFields,
      );
      const last = one(
        `SELECT id,revision,status FROM artifacts WHERE run_id=? AND from_role_id=?
        AND phase=? ORDER BY revision DESC LIMIT 1`,
        run,
        roleId,
        row.phase,
      );
      if (last && last.status !== "returned")
        conflict("只能修订被退回的已交付版本。");
      if (
        dto.baseRevision !== undefined &&
        dto.baseRevision !== (last?.revision ?? 0)
      )
        conflict("产物基线版本已变更。");
      const artifact = {
        id: last?.id ?? randomUUID(),
        revision: (last?.revision ?? 0) + 1,
        run_id: run,
        from_role_id: roleId,
        to_role_id: next.id,
        title,
        body: dto.body,
        summary,
        fields_json: JSON.stringify(fields),
        submitted_by: actor,
        phase: row.phase,
        supersedes_revision: last?.revision,
      };
      insertArtifact(artifact);
      if (next.delivery?.kind === "qa")
        saveCandidate(artifact, candidate, next.delivery.files);
      write("UPDATE runs SET current_role_id=? WHERE id=?", next.id, run);
      record(run, actor, roleId, "submitted", artifact.id, artifact.revision);
      if (next.kind === "agent" && next.autoStartOnHandoff) {
        // The terminal role must still explicitly verify the workflow's completion condition.
        if (next.id !== roles.at(-1).id && !next.delivery) {
          write(
            "UPDATE artifacts SET status='accepted',reviewed_by=?,reviewed_at=? WHERE id=? AND revision=?",
            next.assigneeId,
            now(),
            artifact.id,
            artifact.revision,
          );
          record(
            run,
            next.assigneeId,
            next.id,
            "auto_accepted",
            artifact.id,
            artifact.revision,
          );
        }
        enqueue(run, next, "handoff", artifact, row.phase);
      }
      return getRun(actor, run);
    });
  }
  function editDesign(actor, a, dto, from) {
    requiredText(dto.body, "修改后的设计", 250000);
    const title =
      dto.title === undefined ? a.title : requiredText(dto.title, "产物标题");
    const summary =
      dto.summary === undefined
        ? a.summary
        : requiredText(dto.summary, "交接摘要", 4000);
    const fields = fieldsFor(
      dto.fields ?? JSON.parse(a.fields_json),
      from.requiredFields,
    );
    if (
      a.title === title &&
      a.body === dto.body &&
      a.summary === summary &&
      JSON.stringify(canonical(JSON.parse(a.fields_json))) ===
        JSON.stringify(canonical(fields))
    ) {
      invalid("新版本没有变更。");
    }
    write(
      "UPDATE artifacts SET status='superseded',reviewed_by=?,reviewed_at=? WHERE id=? AND revision=?",
      actor,
      now(),
      a.id,
      a.revision,
    );
    insertArtifact({
      ...a,
      revision: a.revision + 1,
      body: dto.body,
      title,
      summary,
      fields_json: JSON.stringify(fields),
      supersedes_revision: a.revision,
      edited_by: actor,
    });
    record(a.run_id, actor, a.to_role_id, "edited", a.id, a.revision + 1);
  }
  function reviewArtifact(actor, run, dto) {
    object(dto, "签收");
    const artifactId = requiredText(dto.artifactId, "产物 ID");
    if (
      !Number.isSafeInteger(dto.revision) ||
      dto.revision < 1 ||
      !["accept", "return", "edit", "confirm_start"].includes(dto.action)
    ) {
      invalid("签收动作或版本无效。");
    }
    return tx(() => {
      const row = runRow(actor, run);
      const a = one(
        "SELECT * FROM artifacts WHERE id=? AND revision=? AND run_id=?",
        artifactId,
        dto.revision,
        run,
      );
      if (!a) fail(404, "not_found", "找不到该版本产物。");
      const reviewer = assignedRole(actor, row, a.to_role_id);
      if (reviewer.delivery)
        conflict("该产物由 QA 或发布策略的真实回执自动签收或退回。");
      if (receipt(actor, run, dto.requestId, { action: "review", dto }))
        return getRun(actor, run);
      activeRole(row, a.to_role_id);
      if (pendingTurn(run, a.to_role_id) || activeJob(run, a.to_role_id))
        conflict("先完成或核对本轮执行，再处理产物。");
      if (a.status !== "pending" || a.phase !== row.phase)
        conflict("该版本已经处理，请核对待签收版本。");
      const roles = storedRoles(row.roles_json);
      const from = roles.find((r) => r.id === a.from_role_id);
      const design =
        a.phase === "handoff" &&
        reviewer.reviewMode === "design" &&
        from.kind === "agent";
      if (["edit", "confirm_start"].includes(dto.action) && !design)
        conflict("当前产物不适用设计评审动作。");
      if (dto.action === "accept" && design)
        conflict("请明确确认此版设计并开始开发，或退回修改。");
      if (dto.action === "edit") {
        editDesign(actor, a, dto, from);
        return getRun(actor, run);
      }
      const returned = dto.action === "return";
      const feedback = returned
        ? requiredText(dto.feedback, "退回意见", 4000)
        : optionalText(dto.feedback, "签收说明", 4000);
      const timestamp = now();
      write(
        "UPDATE artifacts SET status=?,feedback=?,reviewed_by=?,reviewed_at=? WHERE id=? AND revision=?",
        returned ? "returned" : "accepted",
        feedback,
        actor,
        timestamp,
        a.id,
        a.revision,
      );
      if (dto.action === "confirm_start") {
        const approval = {
          artifactId: a.id,
          revision: a.revision,
          roleId: from.id,
          reviewerRoleId: reviewer.id,
          approvedBy: actor,
          approvedAt: timestamp,
        };
        write(
          "UPDATE runs SET current_role_id=?,phase='implementation',approved_design_json=? WHERE id=?",
          from.id,
          JSON.stringify(approval),
          run,
        );
        enqueue(run, from, "confirm_start", a, "implementation");
        record(run, actor, reviewer.id, "confirm_start", a.id, a.revision);
      } else {
        const finished = !returned && roles.at(-1).id === reviewer.id;
        // Once a nonterminal reviewer accepts implementation, later roles use their usual handoff rules.
        const nextPhase =
          !returned && !finished && a.phase === "implementation"
            ? "handoff"
            : row.phase;
        write(
          "UPDATE runs SET current_role_id=?,status=?,phase=? WHERE id=?",
          returned ? from.id : reviewer.id,
          finished ? "completed" : "active",
          nextPhase,
          run,
        );
        record(
          run,
          actor,
          reviewer.id,
          returned ? "returned" : "accepted",
          a.id,
          a.revision,
        );
        if (returned && from.kind === "agent" && from.autoStartOnHandoff)
          enqueue(run, from, "return", a, a.phase);
        if (finished)
          record(run, actor, reviewer.id, "completed", a.id, a.revision);
      }
      return getRun(actor, run);
    });
  }
  return {
    owner,
    getUser,
    listMembers,
    createInvite,
    redeemInvite,
    createTeam,
    updateTeam,
    listTeams,
    getTeam,
    startRun,
    listRuns,
    getRun,
    getSession,
    listPendingTurns,
    listQueuedHandoffs,
    claimHandoff,
    listPreparedHandoffs,
    markHandoffDispatched,
    bindNativeSession,
    beginTurn,
    finishTurn,
    failTurn,
    submitArtifact,
    replayedSubmission,
    getDeliveryJob,
    listDeliveryWork,
    beginDeliveryAction,
    finishDeliveryAction,
    markDeliveryActionUnknown,
    recoverDeliveryActions,
    settleDelivery,
    submitRepair,
    blockDelivery,
    reviewArtifact,
    close: () => db.close(),
  };
}
