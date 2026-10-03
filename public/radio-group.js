const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function nextRadioIndex(key, current, count) {
  if (count < 1) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = STEP[key];
  if (step === undefined) return null;
  if (current < 0 || current >= count) return step > 0 ? 0 : count - 1;
  return (current + step + count) % count;
}

const radiosOf = (group) => [...group.querySelectorAll('[role="radio"]')];

// 選択中の1つだけを Tab の止まり先にする（他は -1）。どの描画処理が aria-checked を変えても追従する。
function syncTabStops(group) {
  const radios = radiosOf(group);
  const stop = Math.max(0, radios.findIndex((radio) => radio.getAttribute("aria-checked") === "true"));
  radios.forEach((radio, index) => { radio.tabIndex = index === stop ? 0 : -1; });
}

export function bindRadioGroups(root = document) {
  for (const group of root.querySelectorAll('[role="radiogroup"]')) {
    syncTabStops(group);
    new MutationObserver(() => syncTabStops(group)).observe(group, { subtree: true, attributes: true, attributeFilter: ["aria-checked"] });
    group.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const radios = radiosOf(group);
      const current = radios.indexOf(event.target);
      if (current < 0) return;
      const next = nextRadioIndex(event.key, current, radios.length);
      if (next === null) return;
      event.preventDefault();
      const radio = radios[next];
      if (radio.getAttribute("aria-checked") !== "true") radio.click();
      if (radio.getAttribute("aria-checked") === "true") radio.focus();
    });
  }
}
