import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGithubBlobUrl, isRefStale, parseGithubRemote, resolveGitRepo } from "./git-url.ts";

const repo = { owner: "aki77", repo: "kuroko", ref: "abc123" };
const clean = () => false;
const dirty = () => true;
const fresh = () => false;
const stale = () => true;

test("buildGithubBlobUrl: 行番号付きref -> #L付きURL", () => {
  assert.equal(
    buildGithubBlobUrl("src/foo.ts:12", repo, "/x", clean, fresh),
    "https://github.com/aki77/kuroko/blob/abc123/src/foo.ts#L12",
  );
});

test("buildGithubBlobUrl: 範囲行番号ref -> #L-L付きURL", () => {
  assert.equal(
    buildGithubBlobUrl("src/foo.ts:12-20", repo, "/x", clean, fresh),
    "https://github.com/aki77/kuroko/blob/abc123/src/foo.ts#L12-L20",
  );
});

test("buildGithubBlobUrl: 行なしref -> 行アンカーなし", () => {
  assert.equal(
    buildGithubBlobUrl("src/foo.ts", repo, "/x", clean, fresh),
    "https://github.com/aki77/kuroko/blob/abc123/src/foo.ts",
  );
});

test("buildGithubBlobUrl: 複数コロン(path側にコロン残り) -> null", () => {
  assert.equal(buildGithubBlobUrl("src/foo.ts:12:34", repo, "/x", clean, fresh), null);
});

test("buildGithubBlobUrl: 絶対パス -> null", () => {
  assert.equal(buildGithubBlobUrl("/etc/x:1", repo, "/x", clean, fresh), null);
});

test("buildGithubBlobUrl: '..'含み -> null", () => {
  assert.equal(buildGithubBlobUrl("../secret:1", repo, "/x", clean, fresh), null);
});

test("buildGithubBlobUrl: 空白含み -> null", () => {
  assert.equal(buildGithubBlobUrl("src/foo bar.ts:1", repo, "/x", clean, fresh), null);
});

test("buildGithubBlobUrl: dirtyな対象pathは行番号を落としベースURLのみ", () => {
  assert.equal(
    buildGithubBlobUrl("src/foo.ts:12", repo, "/x", dirty, fresh),
    "https://github.com/aki77/kuroko/blob/abc123/src/foo.ts",
  );
});

test("buildGithubBlobUrl: キャッシュ済みrefが現在HEADと不一致(stale)なら行番号を落としベースURLのみ", () => {
  assert.equal(
    buildGithubBlobUrl("src/foo.ts:12", repo, "/x", clean, stale),
    "https://github.com/aki77/kuroko/blob/abc123/src/foo.ts",
  );
});

test("buildGithubBlobUrl: staleかつdirtyでも行番号を落としベースURLのみ", () => {
  assert.equal(
    buildGithubBlobUrl("src/foo.ts:12", repo, "/x", dirty, stale),
    "https://github.com/aki77/kuroko/blob/abc123/src/foo.ts",
  );
});

test("isRefStale: refがSHA形式でない(ブランチ名フォールバック)場合は常に非stale", () => {
  assert.equal(isRefStale(".", "main"), false);
});

test("parseGithubRemote: ssh形式", () => {
  assert.deepEqual(parseGithubRemote("git@github.com:aki77/kuroko.git"), {
    owner: "aki77",
    repo: "kuroko",
  });
});

test("parseGithubRemote: https形式", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/aki77/kuroko.git"), {
    owner: "aki77",
    repo: "kuroko",
  });
});

test("parseGithubRemote: 非githubリモート -> null", () => {
  assert.equal(parseGithubRemote("https://gitlab.com/aki77/kuroko.git"), null);
});

test("resolveGitRepo: 同一projectDirはキャッシュを返す（会議中はgitを叩かない）", () => {
  let calls = 0;
  const resolve = () => {
    calls++;
    return repo;
  };
  resolveGitRepo("/meeting-1-a", resolve);
  resolveGitRepo("/meeting-1-a", resolve);
  assert.equal(calls, 1);
});

test("resolveGitRepo: projectDirが変わると再解決する（会議境界でrefを引き直す＝古いref固定の解消）", () => {
  const repoA = { owner: "aki77", repo: "kuroko", ref: "sha-a" };
  const repoB = { owner: "aki77", repo: "kuroko", ref: "sha-b" };
  assert.deepEqual(
    resolveGitRepo("/meeting-2-a", () => repoA),
    repoA,
  );
  assert.deepEqual(
    resolveGitRepo("/meeting-2-b", () => repoB),
    repoB,
  );
});

test("resolveGitRepo: nullは毎回リトライする（null固定の解消）", () => {
  let calls = 0;
  const resolve = () => {
    calls++;
    return null;
  };
  resolveGitRepo("/meeting-3-a", resolve);
  resolveGitRepo("/meeting-3-a", resolve);
  assert.equal(calls, 2);
});

test("resolveGitRepo: 一時失敗の後に成功すれば復活する（gitロック解除後の復活）", () => {
  let calls = 0;
  const resolve = () => {
    calls++;
    return calls === 1 ? null : repo;
  };
  assert.equal(resolveGitRepo("/meeting-4-a", resolve), null);
  assert.deepEqual(resolveGitRepo("/meeting-4-a", resolve), repo);
});

test("resolveGitRepo: 成功後の再訪はキャッシュされresolveが呼ばれない", () => {
  let calls = 0;
  const resolve = () => {
    calls++;
    return repo;
  };
  resolveGitRepo("/meeting-5-a", resolve);
  resolveGitRepo("/meeting-5-a", resolve);
  assert.equal(calls, 1);
});
