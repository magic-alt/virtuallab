import { describe, expect, it } from "vitest";
import { correlatePrHead, gitOidMatches, suggestedReviewBranch } from "./reviewLoop";

const pr = {headSha:"abcdef1234567890",baseSha:"1234567890abcdef"};
describe("review loop identity", () => {
  it("correlates local HEAD with PR head/base without accepting placeholders",()=>{
    expect(correlatePrHead("abcdef1234",pr)).toBe("head");
    expect(correlatePrHead("1234567890",pr)).toBe("base");
    expect(correlatePrHead("fffffffffff",pr)).toBe("diverged");
    expect(correlatePrHead("preview",pr)).toBe("unknown");
    expect(gitOidMatches("abc","abc")).toBe(false);
  });
  it("suggests a repository-neutral worktree branch",()=>{
    expect(suggestedReviewBranch({kind:"issue",number:42,reference:"https://github.com/example/repo/issues/42"})).toBe("review/issue-42");
    expect(suggestedReviewBranch({kind:"pr",number:7,reference:"pr:7"})).toBe("review/pr-7");
    expect(()=>suggestedReviewBranch({kind:"pr",number:0,reference:"pr:0"})).toThrow();
  });
});
