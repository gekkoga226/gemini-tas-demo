// Layout and readability checks. inspectPage runs inside the page (serialized with Function#toString),
// so it must stay self-contained: no imports and no references to module scope.
export function inspectPage({ scope = ['body'], minFontPx = 12, minContrast = 4.5, maxItems = 150 } = {}) {
  const root = document.documentElement;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const styles = new Map();
  const css = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colors = new Map();
  const parse = (value) => {
    if (colors.has(value)) return colors.get(value);
    let c;
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(value);
    if (m) c = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[5] ? m[4] / 100 : +m[4]];
    else { // oklch(), color(), lab() ... converted to sRGB by the canvas
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data; c = [d[0], d[1], d[2], d[3] / 255];
    }
    colors.set(value, c);
    return c;
  };
  const blend = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    return a ? [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a) : [0, 0, 0, 0];
  };
  const luminance = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  const shown = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false; // off-screen skip links etc.
    const s = css(el);
    if (s.clipPath === 'inset(50%)' || /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(s.clip)) return false; // visually hidden text
    return !(r.width <= 1 && r.height <= 1 && s.overflow === 'hidden');
  };
  const describe = (el) => {
    const parts = [];
    for (let e = el, depth = 0; e && depth < 3; e = e.parentElement, depth++) {
      if (e.id) { parts.unshift('#' + e.id); break; }
      parts.unshift(e.localName + [...e.classList].slice(0, 2).map((c) => '.' + c).join(''));
      if (e === document.body) break;
    }
    return parts.join(' > ');
  };
  const textOf = (el) => {
    let t;
    if (el.localName === 'select') t = el.selectedOptions[0]?.textContent;
    else if (el.matches('input,textarea')) t = el.value || el.placeholder;
    else { // prefer the element's own text (a label should not list the options of the select inside it)
      t = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join(' ');
      if (!/\S/.test(t)) t = el.textContent;
    }
    return (t ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  };
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && /\S/.test(n.data));

  const elements = new Set();
  for (const start of new Set(scope.flatMap((s) => [...document.querySelectorAll(s)]))) {
    elements.add(start);
    for (const e of start.querySelectorAll('*')) elements.add(e);
  }

  // 1. Horizontal scroll of the whole page, with the outermost elements that stick out.
  const page = { scroll_width: root.scrollWidth, client_width: vw, scroll_height: root.scrollHeight, client_height: vh,
    hscroll: root.scrollWidth > vw, vscroll: root.scrollHeight > vh, offenders: [] };
  if (page.hscroll) {
    const found = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right + scrollX <= vw + 1 || !shown(el)) continue;
      let clipped = false;
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (css(e).overflowX !== 'visible') { clipped = true; break; }
      if (!clipped) found.push({ el, right: Math.round(r.right + scrollX), width: Math.round(r.width) });
    }
    const set = new Set(found.map((f) => f.el));
    page.offenders = found.filter((f) => { for (let e = f.el.parentElement; e; e = e.parentElement) if (set.has(e)) return false; return true; })
      .sort((a, b) => b.right - a.right).slice(0, 10)
      .map((f) => ({ selector: describe(f.el), text: textOf(f.el), right: f.right, width: f.width }));
  }

  // 2. Text or controls cut off / spilling out of their own box.
  const TARGETS = 'button,a,label,summary,select,th,td,dt,dd,legend,output,h1,h2,h3,h4,h5,h6,[role=tab],[role=button],[role=link],[role=menuitem],[role=option],'
    + '[class*=badge],[class*=chip],[class*=pill],[class*=tag],[class*=label],[class*=title]';
  let overflow = [];
  for (const el of elements) {
    if (!(el instanceof HTMLElement) || el.matches('html,body,input,textarea') || !(el.matches(TARGETS) || hasText(el))) continue;
    const s = css(el);
    if (s.display === 'inline' || s.display === 'contents' || /auto|scroll/.test(s.overflowX)) continue;
    if (el.scrollWidth <= el.clientWidth + 1 || !shown(el)) continue;
    overflow.push({ el, selector: describe(el), text: textOf(el), scroll_width: el.scrollWidth, client_width: el.clientWidth,
      cut: s.overflowX !== 'visible', ellipsis: s.textOverflow === 'ellipsis' });
  }
  const flagged = new Set(overflow.map((o) => o.el));
  overflow = overflow.filter((o) => ![...o.el.querySelectorAll('*')].some((d) => flagged.has(d))).map(({ el, ...rest }) => rest); // keep the innermost

  // 2b. Boxes that cut off their own content: overflow hidden/clip on the block axis, content taller than the box by 1px or more.
  // Deliberate clamps (-webkit-line-clamp) are skipped. Boxes that scroll (auto/scroll) are not cut off, they are reachable.
  let clipped = [];
  for (const el of elements) {
    if (!(el instanceof HTMLElement) || el.matches('html,body')) continue;
    const s = css(el);
    if (!/^(hidden|clip)$/.test(s.overflowY) || s.display === 'inline' || s.display === 'contents' || s.webkitLineClamp !== 'none') continue;
    if (el.scrollHeight < el.clientHeight + 1 || !shown(el)) continue;
    clipped.push({ el, selector: describe(el), text: textOf(el), scroll_height: el.scrollHeight, client_height: el.clientHeight,
      hidden_px: el.scrollHeight - el.clientHeight });
  }
  const cutBoxes = new Set(clipped.map((c) => c.el));
  clipped = clipped.filter((c) => ![...c.el.querySelectorAll('*')].some((d) => cutBoxes.has(d))).map(({ el, ...rest }) => rest); // keep the innermost

  // 3 and 4. Font size and contrast of every visible piece of text.
  const FIELD = 'input:not([type=hidden],[type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image]),textarea,select';
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'option', 'optgroup', 'title']);
  const media = [...document.querySelectorAll('video,img,canvas,iframe,object,embed')].filter(shown).map((m) => [m, m.getBoundingClientRect()]);
  const overMedia = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return media.some(([m, mr]) => !m.contains(el) && !el.contains(m) && x >= mr.left && x <= mr.right && y >= mr.top && y <= mr.bottom);
  };
  const background = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = css(e);
      const c = parse(s.backgroundColor);
      // A gradient or picture behind the text cannot be judged; a small no-repeat icon on a solid color (select arrow) can.
      if (s.backgroundImage !== 'none' && !(!/gradient\(/.test(s.backgroundImage) && /^no-repeat/.test(s.backgroundRepeat) && c[3] >= 0.999)) return null;
      if (c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    return layers.reduceRight((bg, layer) => blend(layer, bg), [255, 255, 255, 1]);
  };
  const smallText = [];
  const lowContrast = [];
  const excluded = { image: 0, media: 0, disabled: 0 };
  for (const el of elements) {
    if (SKIP.has(el.localName)) continue;
    const field = el.matches(FIELD);
    if (!field && !hasText(el)) continue;
    if (!shown(el)) continue;
    const s = css(el);
    const svg = el instanceof SVGElement;
    const ctm = svg ? el.getScreenCTM() : null;
    const size = parseFloat(s.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
    if (size < 1) continue; // font-size: 0 hides the label of icon-only buttons; nothing is drawn
    const weight = Number(s.fontWeight) || 400;
    const item = { selector: describe(el), text: textOf(el), font_px: Math.round(size * 10) / 10 };
    if (size < minFontPx) smallText.push(item);

    if (el.matches(':disabled') || el.closest('[aria-disabled="true"],fieldset:disabled,[inert]')) { excluded.disabled++; continue; }
    const placeholder = el.matches('input,textarea') && !el.value;
    const paint = placeholder ? getComputedStyle(el, '::placeholder').color : svg ? s.fill : s.color;
    if (svg && !/^(rgb|#|oklch|oklab|lab|lch|color|hsl)/.test(paint)) continue; // fill: none / url(...)
    const fg = parse(paint);
    let opacity = 1;
    for (let e = el; e; e = e.parentElement) opacity *= parseFloat(css(e).opacity);
    if (fg[3] * opacity <= 0) continue;
    if (overMedia(el)) { excluded.media++; continue; }
    const bg = background(el);
    if (!bg) { excluded.image++; continue; }
    const text = blend([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const ratio = contrast(text, bg);
    if (ratio < minContrast) {
      lowContrast.push({ ...item, ratio: Math.round(ratio * 100) / 100, color: hex(text), background: hex(bg),
        large_text: size >= 24 || (size >= 18.66 && weight >= 700) });
    }
  }

  const cap = (list) => list.slice(0, maxItems);
  return {
    title: document.title, scope,
    page,
    overflow: cap(overflow), clipped: cap(clipped), small_text: cap(smallText), contrast: cap(lowContrast), contrast_excluded: excluded,
    counts: { hscroll: page.hscroll ? 1 : 0, overflow: overflow.length, clipped: clipped.length, small_text: smallText.length, contrast: lowContrast.length },
  };
}
