// 拉取 PR 逐行评论。
import { execSync } from "node:child_process";
const out = execSync('gh api "repos/Moyf/moys-asr-workflow/pulls/136/comments" --paginate', { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const comments = JSON.parse(out);
for (const c of comments) {
  const first = c.body.split("\n").slice(0, 3).join(" / ");
  console.log(`[${c.path}:${c.line ?? c.original_line}] ${first}`);
  console.log("---");
}
console.log(`共 ${comments.length} 条逐行评论`);
