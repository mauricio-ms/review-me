import { Vim } from "@replit/codemirror-vim";

type CommitMessageActions = {
  commit: () => void;
  abort: () => void;
};

let defined = false;
let actions: CommitMessageActions | null = null;

export function setCommitMessageActions(next: CommitMessageActions | null): void {
  actions = next;
}

/** Vim ex commands for the commit-message editor: `:wq`/`:x` commit, `:q` abort. */
export function defineCommitMessageVim(): void {
  if (defined) return;
  defined = true;
  const v = Vim as unknown as {
    defineEx: (name: string, prefix: string, fn: () => void) => void;
  };
  v.defineEx("wqReviewMeCommit", "wq", () => actions?.commit());
  v.defineEx("xReviewMeCommit", "x", () => actions?.commit());
  v.defineEx("qReviewMeCommit", "q", () => actions?.abort());
  v.defineEx("cqReviewMeCommit", "cq", () => actions?.abort());
}
