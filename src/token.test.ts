import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stateDbCandidates,
  decodeJwt,
  normalizeSub,
  buildWorkosCookie,
  teamIdFromCachedTeam,
} from "./token.js";

const REL = "Cursor/User/globalStorage/state.vscdb";

test("stateDbCandidates: macOS path", () => {
  const [p] = stateDbCandidates({}, "darwin", "/Users/me");
  assert.equal(p, `/Users/me/Library/Application Support/${REL}`);
});

test("stateDbCandidates: Linux uses XDG_CONFIG_HOME then ~/.config", () => {
  assert.equal(
    stateDbCandidates({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/me")[0],
    `/cfg/${REL}`,
  );
  assert.equal(stateDbCandidates({}, "linux", "/home/me")[0], `/home/me/.config/${REL}`);
});

test("stateDbCandidates: Windows uses APPDATA (Roaming)", () => {
  const [p] = stateDbCandidates({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me");
  assert.ok(p.endsWith("Cursor\\User\\globalStorage\\state.vscdb") || p.includes("Roaming"));
});

test("stateDbCandidates: CURSOR_STATE_DB override comes first", () => {
  const list = stateDbCandidates({ CURSOR_STATE_DB: "/custom/state.vscdb" }, "darwin", "/Users/me");
  assert.equal(list[0], "/custom/state.vscdb");
  assert.equal(list.length, 2, "override plus the platform default");
});

function fakeJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

test("decodeJwt pulls sub and exp, tolerates junk", () => {
  assert.deepEqual(decodeJwt(fakeJwt({ sub: "auth0|user_1", exp: 123 })), {
    sub: "auth0|user_1",
    exp: 123,
  });
  assert.equal(decodeJwt("not-a-jwt"), undefined);
  assert.deepEqual(decodeJwt(fakeJwt({ nope: true })), { sub: undefined, exp: undefined });
});

test("normalizeSub strips the provider prefix", () => {
  assert.equal(normalizeSub("auth0|user_01ABC"), "user_01ABC");
  assert.equal(normalizeSub("user_01ABC"), "user_01ABC");
});

test("buildWorkosCookie has the exact dashboard shape", () => {
  assert.equal(
    buildWorkosCookie("user_01ABC", "eyJ.token.sig"),
    "WorkosCursorSessionToken=user_01ABC::eyJ.token.sig",
  );
});

test("teamIdFromCachedTeam handles teamId/id/nested and rejects junk", () => {
  assert.equal(teamIdFromCachedTeam(JSON.stringify({ teamId: 13227681, name: "x" })), "13227681");
  assert.equal(teamIdFromCachedTeam(JSON.stringify({ id: 42 })), "42");
  assert.equal(teamIdFromCachedTeam(JSON.stringify({ team: { id: "7" } })), "7");
  assert.equal(teamIdFromCachedTeam(undefined), undefined);
  assert.equal(teamIdFromCachedTeam("not json"), undefined);
  assert.equal(teamIdFromCachedTeam(JSON.stringify({ name: "no id" })), undefined);
});
