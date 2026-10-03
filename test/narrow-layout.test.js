import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WIDE_LAYOUT, followVisualOrder, isStackedLayout } from "../public/narrow-layout.js";

// A stand-in for the two blocks: `html` is the order they are written in, the way a Tab key walks them.
// Like a browser, moving the panel drops the focus that sits inside it; `row.focus()` takes it back.
function fakePage() {
  const html = ["panel", "timebar"];
  const body = { name: "body" };
  const document = { activeElement: body };
  const row = { name: "row", focusCalls: [], focus(options) { this.focusCalls.push(options); document.activeElement = row; } };
  const panel = { name: "panel", ownerDocument: document, contains: (node) => node === row };
  const place = (offset) => (node) => {
    assert.equal(node, panel, "only the panel is ever moved");
    html.splice(html.indexOf("panel"), 1);
    html.splice(html.indexOf("timebar") + offset, 0, "panel");
    if (panel.contains(document.activeElement)) document.activeElement = body;
  };
  return { html, panel, row, body, document, timebar: { before: place(0), after: place(1) } };
}

function fakeQuery(matches) {
  const listeners = [];
  return {
    matches,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.push(listener); },
    resize(value) { this.matches = value; listeners.forEach((listener) => listener({ matches: value })); },
  };
}

test("from 1200px wide the panel stays before the time bar, as the side-by-side layout needs", () => {
  const page = fakePage();
  followVisualOrder({ panel: page.panel, timebar: page.timebar, query: fakeQuery(true) });
  assert.deepEqual(page.html, ["panel", "timebar"]);
});

test("below 1200px the panel is written after the time bar, the order it is drawn in", () => {
  const page = fakePage();
  followVisualOrder({ panel: page.panel, timebar: page.timebar, query: fakeQuery(false) });
  assert.deepEqual(page.html, ["timebar", "panel"]);
});

test("from 1200px wide the page is not touched at all, so the wide layout behaves exactly as before", () => {
  const touched = [];
  const timebar = { before: () => touched.push("before"), after: () => touched.push("after") };
  const query = fakeQuery(true);
  followVisualOrder({ panel: {}, timebar, query });
  query.resize(true);
  assert.deepEqual(touched, []);
});

test("crossing 1200px in either direction moves the panel again", () => {
  const page = fakePage();
  const query = fakeQuery(true);
  followVisualOrder({ panel: page.panel, timebar: page.timebar, query });
  query.resize(false);
  assert.deepEqual(page.html, ["timebar", "panel"]);
  query.resize(true);
  assert.deepEqual(page.html, ["panel", "timebar"]);
  query.resize(false);
  assert.deepEqual(page.html, ["timebar", "panel"]);
});

test("a control focused inside the panel keeps the focus when crossing 1200px in either direction (R13)", () => {
  const page = fakePage();
  const query = fakeQuery(true);
  followVisualOrder({ panel: page.panel, timebar: page.timebar, query });
  page.document.activeElement = page.row;
  query.resize(false);
  assert.equal(page.document.activeElement, page.row, "narrowing");
  query.resize(true);
  assert.equal(page.document.activeElement, page.row, "widening");
  query.resize(false);
  assert.equal(page.document.activeElement, page.row, "narrowing again");
});

test("the focus is given back without scrolling the page", () => {
  const page = fakePage();
  const query = fakeQuery(true);
  followVisualOrder({ panel: page.panel, timebar: page.timebar, query });
  page.document.activeElement = page.row;
  query.resize(false);
  assert.deepEqual(page.row.focusCalls, [{ preventScroll: true }]);
});

test("focus outside the panel, or none at all, is left alone when the panel moves", () => {
  const page = fakePage();
  const elsewhere = { name: "elsewhere", focus() { assert.fail("must not take the focus"); } };
  const query = fakeQuery(true);
  followVisualOrder({ panel: page.panel, timebar: page.timebar, query });
  query.resize(false);
  assert.equal(page.document.activeElement, page.body);
  page.document.activeElement = elsewhere;
  query.resize(true);
  assert.equal(page.document.activeElement, elsewhere);
  assert.deepEqual(page.row.focusCalls, []);
});

test("isStackedLayout is the opposite of the side-by-side layout", () => {
  assert.equal(isStackedLayout({ matches: true }), false);
  assert.equal(isStackedLayout({ matches: false }), true);
});

test("the width is the one styles.css uses for the side-by-side layout", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.ok(css.includes(`@media ${WIDE_LAYOUT} {\n  .workspace {`.replace("\n", css.includes("\r\n") ? "\r\n" : "\n")), `styles.css must open its ${WIDE_LAYOUT} workspace block`);
});
