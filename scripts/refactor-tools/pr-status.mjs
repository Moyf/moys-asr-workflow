// 拉取 PR #136 最新评论（避免 PS 引号问题）。
import { execSync } from "node:child_process";
const out = execSync('gh pr view 136 --json comments,reviews --jq "{c: [.comments[] | {a: .author.login, t: (.body | split(\\"\\n\\")[0] | .[0:110])}], r: [.reviews[] | {a: .author.login, s: .state, t: (.body | split(\\"\\n\\")[0] | .[0:110])}]}"', { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: "cmd.exe" });
const data = JSON.parse(out);
console.log("== 评论 ==");
data.c.slice(-4).forEach((c) => console.log(`${c.a}: ${c.t}`));
console.log("== 评审 ==");
data.r.forEach((r) => console.log(`${r.a} [${r.s}]: ${r.t}`));
