export const NO_EXAMPLES_NOTE = "お手本（動画・記述・画像）は分析に送っていません。作業名一覧だけを使っています。";

export function resultSetLabels({ examplesUsed, set, sourceCount }) {
  if (!set) return { chip: "", note: "" };
  if (examplesUsed) return { chip: `お手本セット：${set.name}（${sourceCount}本）`, note: "" };
  return { chip: `作業名一覧：${set.name}`, note: NO_EXAMPLES_NOTE };
}

export function standardNotice(examplesUsed) {
  return examplesUsed ? "お手本は公開済みのお手本セットから選んだものです。対象動画のGTは表示しません。" : NO_EXAMPLES_NOTE;
}
