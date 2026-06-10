import assert from "node:assert/strict";
import { normalizeBodyText, renderNovelMarkup } from "./markup.mjs";

assert.equal(normalizeBodyText("{振り仮名}{ふりがな}"), "振り仮名");
assert.equal(normalizeBodyText("\\{通常\\}"), "{通常}");
assert.equal(normalizeBodyText("{強調}{・}"), "強調");

const rendered = renderNovelMarkup("雨の{匂い}{におい}");
assert.match(rendered.html, /<ruby>/);
assert.match(rendered.html, /data-offset="0"/);
assert.equal(rendered.plainText, "雨の匂い");

const multiline = renderNovelMarkup("一\n二\n三");
assert.equal(multiline.plainText.indexOf("三"), 4);
assert.match(multiline.html, /<br data-offset="1" data-length="1" data-newline="true">/);
assert.match(multiline.html, /<span class="line-gap" aria-hidden="true"><\/span>/);
assert.match(multiline.html, /data-offset="4" data-length="1">三/);

const multilineRuby = renderNovelMarkup("一\n{匂い}{におい}\n三");
assert.equal(multilineRuby.plainText.slice(2, 4), "匂い");
assert.match(multilineRuby.html, /data-offset="2" data-length="1">匂/);
assert.match(multilineRuby.html, /data-offset="5" data-length="1">三/);

const emoji = renderNovelMarkup("🙂後");
assert.equal(emoji.plainText.slice(2, 3), "後");
assert.match(emoji.html, /data-offset="0" data-length="2">🙂/u);
assert.match(emoji.html, /data-offset="2" data-length="1">後/u);

console.log("markup tests passed");
