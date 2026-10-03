// 結果画面は 1200px 以上で「動画｜確認パネル」を横に並べ、それより狭いと動画・時間バー・確認パネルを縦に積む。styles.css の @media と同じ幅。
export const WIDE_LAYOUT = "(min-width: 1200px)";

export const isStackedLayout = (query = matchMedia(WIDE_LAYOUT)) => !query.matches;

// 縦に積む幅では確認パネルが時間バーの下に描かれる。HTML の並び（確認パネル → 時間バー）も同じにして、Tab の順を見た目に合わせる。
export function followVisualOrder({ panel, timebar, query = matchMedia(WIDE_LAYOUT) }) {
  let panelIsAfter = false;
  const place = () => {
    const wantAfter = !query.matches;
    if (wantAfter === panelIsAfter) return;
    panelIsAfter = wantAfter;
    // 要素を動かすとパネル内の焦点が外れるので、動かす前に覚えて、動かしたあとに（スクロールさせず）戻す。
    const focused = panel.ownerDocument?.activeElement;
    const keep = focused && panel.contains(focused) ? focused : null;
    if (wantAfter) timebar.after(panel);
    else timebar.before(panel);
    keep?.focus({ preventScroll: true });
  };
  place();
  query.addEventListener("change", place);
}
