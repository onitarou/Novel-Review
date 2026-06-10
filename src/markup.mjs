export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeBodyText(source) {
  const parsed = parseNovelMarkup(source ?? "");
  return parsed.plainText;
}

export function renderNovelMarkup(source) {
  const parsed = parseNovelMarkup(source ?? "");
  let offset = 0;
  let html = "";

  for (const token of parsed.tokens) {
    if (token.type === "text") {
      for (const char of [...token.value]) {
        if (char === "\n") {
          html += lineBreak(offset);
          offset += 1;
          continue;
        }

        html += charSpan(char, offset);
        offset += char.length;
      }
      continue;
    }

    if (token.type === "ruby") {
      const text = [...token.text];
      const base = text.map((char) => {
        const span = charSpan(char, offset);
        offset += char.length;
        return span;
      }).join("");

      html += `<ruby>${base}<rt>${escapeHtml(token.reading)}</rt></ruby>`;
      continue;
    }

    if (token.type === "emphasis") {
      const text = [...token.text];
      const body = text.map((char) => {
        const span = charSpan(char, offset);
        offset += char.length;
        return span;
      }).join("");

      html += `<span class="emphasis">${body}</span>`;
    }
  }

  return {
    html,
    plainText: parsed.plainText
  };
}

function charSpan(char, offset) {
  return `<span data-offset="${offset}" data-length="${char.length}">${escapeHtml(char)}</span>`;
}

function lineBreak(offset) {
  return `<br data-offset="${offset}" data-length="1" data-newline="true"><span class="line-gap" aria-hidden="true"></span>`;
}

function parseNovelMarkup(source) {
  const tokens = [];
  let plainText = "";
  let buffer = "";
  let i = 0;

  const pushText = () => {
    if (!buffer) return;
    tokens.push({ type: "text", value: buffer });
    plainText += buffer;
    buffer = "";
  };

  while (i < source.length) {
    const char = source[i];

    if (char === "\\" && (source[i + 1] === "{" || source[i + 1] === "}")) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    if (char === "{") {
      const firstEnd = source.indexOf("}", i + 1);
      const secondStart = firstEnd + 1;

      if (firstEnd > i && source[secondStart] === "{") {
        const secondEnd = source.indexOf("}", secondStart + 1);
        if (secondEnd > secondStart) {
          const text = source.slice(i + 1, firstEnd);
          const reading = source.slice(secondStart + 1, secondEnd);
          const hasNewline = text.includes("\n") || reading.includes("\n");

          if (!hasNewline && text.length > 0 && reading.length > 0) {
            pushText();
            if (reading === "・" || reading === "﹅") {
              tokens.push({ type: "emphasis", text });
            } else {
              tokens.push({ type: "ruby", text, reading });
            }
            plainText += text;
            i = secondEnd + 1;
            continue;
          }
        }
      }
    }

    buffer += char;
    i += 1;
  }

  pushText();
  return { tokens, plainText };
}
