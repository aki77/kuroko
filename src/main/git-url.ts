// projectDir と ref（"path:line" 形式）から GitHub blob URL を解決するユーティリティ。
// FROM THE CODE の ref をクリック可能なリンクにするために使う。git remote/HEAD SHA を
// 引ければリンク化し、非gitやGitHub以外のremoteなら null を返して従来のテキスト表示に留める。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface GitRepoInfo {
  owner: string;
  repo: string;
  /** HEADのSHA、取れなければデフォルトブランチ名（例: "main"） */
  ref: string;
}

/**
 * git バイナリの実行パスを解決してキャッシュする。
 * Finder/Dockから起動するとログインシェルのPATHを継承しないため、
 * `which git` > よくあるインストール先 の順で探す（resolveClaudeBinと同型）。
 */
let cachedGitBin: string | undefined;
function resolveGitBin(): string {
  if (cachedGitBin) return cachedGitBin;

  try {
    const found = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    if (found) return (cachedGitBin = found);
  } catch {
    // PATHに無い（GUI起動時など）。次のフォールバックへ
  }

  const candidates = ["/opt/homebrew/bin/git", "/usr/bin/git", "/usr/local/bin/git"];
  for (const c of candidates) {
    if (existsSync(c)) return (cachedGitBin = c);
  }

  // 見つからなくても execFileSync に "git" を渡してエラーで拾わせる
  return (cachedGitBin = "git");
}

/** シェルを介さず引数配列で git を実行する。失敗しても例外を投げず null を返す */
function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync(resolveGitBin(), ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** git remote の URL（ssh/https）を owner/repo に分解する。github.com 以外は null */
export function parseGithubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // ssh形式: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

  // https形式: https://github.com/owner/repo(.git)
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  return null;
}

/** 現在のHEADのSHAを取得する。取れなければ null（非git等） */
function resolveHeadSha(projectDir: string): string | null {
  return git(projectDir, ["rev-parse", "HEAD"]);
}

/**
 * projectDir の git remote/HEAD から GitHub リポジトリ情報を解決する（内部ロジック）。
 * 非git・remote が GitHub 以外・ref が全く取れない場合は null。
 */
function resolveGitRepoUncached(projectDir: string): GitRepoInfo | null {
  const remoteUrl = git(projectDir, ["config", "--get", "remote.origin.url"]);
  if (!remoteUrl) return null;

  const parsed = parseGithubRemote(remoteUrl);
  if (!parsed) return null;

  // HEAD SHA優先。未pushでも404になるレアケースは許容し、厳密な判定はしない
  const sha = resolveHeadSha(projectDir);
  if (sha) return { ...parsed, ref: sha };

  // SHAが取れない場合のみデフォルトブランチにフォールバック（例: "origin/main" -> "main"）
  const symbolicRef = git(projectDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (symbolicRef) {
    const branch = symbolicRef.replace(/^origin\//, "");
    if (branch) return { ...parsed, ref: branch };
  }

  return null;
}

/**
 * resolveGitRepoUncached の結果を「直近に解決した projectDir 1 件」だけメモ化する。
 * projectDir は非永続化で会議ごとに変わる（config.ts の NON_PERSISTED_KEYS）。
 * 「会議が変わる」= projectDir の値が変わる、と捉え、前回と異なる projectDir が
 * 来たらキャッシュを捨てて解決し直す。これで会議をまたいでも初回 HEAD SHA が
 * 固定され続けない（会議境界で ref を引き直す）。
 * 同一会議中（同一 projectDir が続く間）は git を一切叩かずキャッシュを返す。
 *
 * 成功結果（GitRepoInfo）のみキャッシュする。null は「一時失敗（gitロック中等）や
 * 非git/非GitHub」を畳んだ値で、成功結果ではないためキャッシュせず毎サイクル再試行する。
 * こうしないと初回の一時失敗が固定され会議中ずっと機能が復活しない。
 * 提案サイクルは triggerCueCount 件ごと＋debounce（既定1.5s）で低頻度、かつ toCode は
 * needsCode 時のみ呼ぶため、null リトライの git 同期コストは無視できる。
 */
let cachedProjectDir: string | undefined;
let cachedRepo: GitRepoInfo | undefined;
export function resolveGitRepo(
  projectDir: string,
  resolve: (dir: string) => GitRepoInfo | null = resolveGitRepoUncached,
): GitRepoInfo | null {
  if (projectDir === cachedProjectDir && cachedRepo) return cachedRepo;

  const result = resolve(projectDir);
  cachedProjectDir = projectDir;
  cachedRepo = result ?? undefined; // null は成功結果でないため保存しない（次回再試行）
  return result;
}

/** 対象pathが作業ツリーでdirty（追跡外/変更/ステージ済みいずれか）かを判定する */
export function isPathDirty(projectDir: string, path: string): boolean {
  const out = git(projectDir, ["status", "--porcelain", "--", path]);
  return out === null ? false : out.length > 0; // 判定不能時は行番号を維持（従来動作）
}

/**
 * キャッシュされた ref（resolveGitRepo が過去に解決したHEADのSHA）が現在のHEADと
 * 一致しないなら true。resolveGitRepo は同一会議中（同一 projectDir が続く間）は
 * 結果をキャッシュするため、会議中にコミットが行われると ref は初回解決時のSHAの
 * まま固定される。isPathDirty は「作業ツリー vs 現在HEAD」しか見ないため、コミット
 * 直後は working tree がクリーンになりdirty判定をすり抜けてしまう。ref自体が現在
 * HEADと一致するかを別途見る。
 *
 * ref が SHA 形式でない場合（resolveGitRepoUncached が HEAD SHA を取得できず
 * ブランチ名にフォールバックしたケース）は、SHA同士の比較が成立せず常に不一致
 * となってしまうため判定をスキップする。ブランチ名refは特定コミットに紐付かず、
 * このケースでの行番号ズレ検知は isPathDirty 側に委ねる。
 */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export function isRefStale(projectDir: string, ref: string): boolean {
  if (!SHA_PATTERN.test(ref)) return false;
  const head = resolveHeadSha(projectDir);
  if (head === null) return false; // 判定不能時は行番号を維持（isPathDirtyと同じ従来動作）
  return head !== ref;
}

/**
 * "path:line" / "path:line-line" / "path"（行なし）形式の ref をパースし、
 * GitHub blob URL を組み立てる。LLM出力を信頼せず、pathが絶対パス・".."含み・
 * 空白/バックスラッシュ含み・末尾行番号剥がし後もコロンが残るなら null を返す。
 * 対象pathが作業ツリーでdirtyな場合、またはキャッシュされた repo.ref が現在の
 * HEADとズレている場合は、行番号と実際のファイル内容が一致する保証がないため
 * 行番号アンカーを付けずベースURL（ファイル先頭）のみ返す。
 */
export function buildGithubBlobUrl(
  rawRef: string,
  repo: GitRepoInfo,
  projectDir: string,
  isDirty: (projectDir: string, path: string) => boolean = isPathDirty,
  isStale: (projectDir: string, ref: string) => boolean = isRefStale,
): string | null {
  // 行番号は末尾の :N / :N-M のみ。それ以外の ':' は path 側に残す。
  const lineMatch = rawRef.match(/:(\d+)(?:-(\d+))?$/);
  const path = lineMatch ? rawRef.slice(0, lineMatch.index) : rawRef;
  const startLine = lineMatch?.[1];
  const endLine = lineMatch?.[2];

  if (!path) return null;
  if (path.startsWith("/")) return null;
  if (path.includes("..")) return null;
  if (/[\s\\]/.test(path)) return null;
  if (path.includes(":")) return null; // 想定外 ref（例: "a.ts:12:34"）→ null で従来テキスト表示に留める

  const encodedPath = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

  const base = `https://github.com/${repo.owner}/${repo.repo}/blob/${repo.ref}/${encodedPath}`;
  if (!startLine) return base;
  if (isStale(projectDir, repo.ref)) return base; // キャッシュされたrefが古いなら行番号は信頼できないため落とす
  if (isDirty(projectDir, path)) return base; // dirtyならHEADの行番号は信頼できないため落とす

  return endLine ? `${base}#L${startLine}-L${endLine}` : `${base}#L${startLine}`;
}
