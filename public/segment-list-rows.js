export const rowKey = (segment, index) => segment?.segment_id ?? `#${index}`;

// 「要確認だけ」の行は選び直しで増減させない（押した行が動くため）。決める時点の行は pins に固定し、あとから選んだ行だけを足す。
export function listRows({ segments, filter, isFlagged, selected, pins }) {
  const all = segments.map((_, index) => index);
  if (filter === "all") return { indexes: all, pins };
  const keys = new Set(pins ?? all.filter(isFlagged).map((index) => rowKey(segments[index], index)));
  if (segments[selected]) keys.add(rowKey(segments[selected], selected));
  return { indexes: all.filter((index) => isFlagged(index) || keys.has(rowKey(segments[index], index))), pins: keys };
}
