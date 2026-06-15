(() => {
  const shell = document.querySelector("[data-reader-shell]");
  const storyBody = document.querySelector("[data-story-body]");
  if (!shell || !storyBody) return;
  const storyContent = storyBody.querySelector(".story-body-content");
  const supportsNativeHangingPunctuation =
    typeof CSS !== "undefined" && CSS.supports?.("hanging-punctuation", "allow-end");
  const hangingPunctuationPattern = /^[、。，．｡､,，.．]$/u;
  let hangingPunctuationFrame = 0;
  let hangingPunctuationResizeObserver = null;

  setupConfirmForms();
  setupMobilePanels();

  const defaults = {
    orientation: "horizontal",
    fontSize: "18",
    lineHeight: "19",
    paragraphGap: "0",
    theme: "light"
  };
  const prefs = { ...defaults, ...readJson("novel_reader_prefs") };
  shell.classList.toggle("needs-hanging-punctuation-fallback", !supportsNativeHangingPunctuation);

  const controls = document.querySelectorAll("[data-pref]");
  for (const control of controls) {
    const key = control.dataset.pref;
    control.value = prefs[key] || defaults[key];
    control.addEventListener("input", () => {
      prefs[key] = control.value;
      localStorage.setItem("novel_reader_prefs", JSON.stringify(prefs));
      applyPrefs(prefs);
    });
  }
  applyPrefs(prefs);
  window.addEventListener("resize", scheduleHangingPunctuationFallback);
  document.fonts?.ready?.then(scheduleHangingPunctuationFallback);
  if (storyContent && "ResizeObserver" in window) {
    hangingPunctuationResizeObserver = new ResizeObserver(scheduleHangingPunctuationFallback);
    hangingPunctuationResizeObserver.observe(storyBody);
  }

  const nameInput = document.querySelector("[data-reader-name]");
  if (nameInput) {
    nameInput.value = localStorage.getItem("novel_reader_name") || "";
    nameInput.addEventListener("input", () => {
      localStorage.setItem("novel_reader_name", nameInput.value);
    });
  }

  const quoteTargets = Array.from(document.querySelectorAll("[data-quote-form]")).map((form) => ({
    form,
    preview: form.querySelector("[data-quote-preview]"),
    insertButton: form.querySelector("[data-insert-quote]"),
    clearButton: form.querySelector("[data-clear-quote]"),
    quoteText: form.querySelector("[data-quote-text]"),
    quoteStart: form.querySelector("[data-quote-start]"),
    quoteEnd: form.querySelector("[data-quote-end]"),
    quoteContextBefore: form.querySelector("[data-quote-context-before]"),
    quoteContextAfter: form.querySelector("[data-quote-context-after]"),
    body: form.querySelector("[data-comment-body]")
  })).filter((target) => target.preview && target.body);
  let selectedQuote = emptyQuote();
  const plainText = storyBody.dataset.plain || "";

  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!storyBody.contains(range.commonAncestorContainer)) return;

    const segments = [];
    for (const node of storyBody.querySelectorAll("[data-offset]")) {
      try {
        if (range.intersectsNode(node)) {
          const start = Number(node.dataset.offset);
          const length = Number(node.dataset.length || "1");
          if (Number.isFinite(start) && Number.isFinite(length)) {
            segments.push({ start, end: start + length });
          }
        }
      } catch {
        // Some browsers throw when checking detached text nodes.
      }
    }

    if (!segments.length) return;

    const start = Math.min(...segments.map((segment) => segment.start));
    const end = Math.max(...segments.map((segment) => segment.end));
    const selected = plainText.slice(start, end);
    const before = plainText.slice(Math.max(0, start - 24), start);
    const after = plainText.slice(end, Math.min(plainText.length, end + 24));

    selectedQuote = {
      text: selected,
      start: String(start),
      end: String(end),
      contextBefore: before,
      contextAfter: after
    };
    updateQuoteTargets();
  };

  storyBody.addEventListener("mouseup", () => setTimeout(captureSelection, 0));
  storyBody.addEventListener("keyup", () => setTimeout(captureSelection, 0));
  for (const target of quoteTargets) {
    target.insertButton?.addEventListener("click", () => {
      insertQuoteIntoDraft(target);
    });
    target.clearButton?.addEventListener("click", () => {
      clearQuote();
      window.getSelection()?.removeAllRanges();
    });
    target.form.addEventListener("submit", () => {
      clearQuoteFields(target);
    });
  }
  updateQuoteTargets();

  const commentList = document.querySelector(".comment-list");
  const cards = document.querySelectorAll("[data-comment-card]");
  for (const card of cards) {
    card.addEventListener("click", (event) => {
      if (event.target.closest("form") || event.target.closest("details")) return;
      selectComment(card);
    });
  }

  const initialComment = commentList?.dataset.selectedComment;
  if (initialComment) {
    const card = Array.from(cards).find((item) => item.dataset.commentCard === initialComment);
    if (card) {
      selectComment(card);
      card.scrollIntoView({ block: "center" });
    }
  }

  function selectComment(card) {
    for (const item of cards) item.classList.remove("selected");
    clearHighlight();
    card.classList.add("selected");

    const start = Number(card.dataset.quoteStart);
    const end = Number(card.dataset.quoteEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;

    for (const node of storyBody.querySelectorAll("[data-offset]")) {
      const offset = Number(node.dataset.offset);
      const length = Number(node.dataset.length || "1");
      const nodeEnd = offset + length;
      if (offset < end && nodeEnd > start) {
        node.classList.add("active-highlight");
      }
    }
  }

  function clearHighlight() {
    for (const node of storyBody.querySelectorAll(".active-highlight")) {
      node.classList.remove("active-highlight");
    }
  }

  function clearQuote() {
    selectedQuote = emptyQuote();
    updateQuoteTargets();
  }

  function clearQuoteFields(target) {
    if (target.quoteText) target.quoteText.value = "";
    if (target.quoteStart) target.quoteStart.value = "";
    if (target.quoteEnd) target.quoteEnd.value = "";
    if (target.quoteContextBefore) target.quoteContextBefore.value = "";
    if (target.quoteContextAfter) target.quoteContextAfter.value = "";
  }

  function insertQuoteIntoDraft(target) {
    if (!target.body || !selectedQuote.text) return;

    const quoteBlock = selectedQuote.text
      .split(/\r?\n/)
      .map((line) => `>> ${line}`)
      .join("\n");
    const current = target.body.value;
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    const suffix = current || prefix ? "\n" : "";

    target.body.value = `${current}${prefix}${quoteBlock}${suffix}`;
    target.body.focus();
    target.body.selectionStart = target.body.value.length;
    target.body.selectionEnd = target.body.value.length;
  }

  function updateQuoteTargets() {
    const hasQuote = Boolean(selectedQuote.text);
    for (const target of quoteTargets) {
      syncQuoteFields(target);
      target.preview.textContent = hasQuote
        ? `引用: ${selectedQuote.text}`
        : "本文を選択すると引用できます。";
      if (target.insertButton) target.insertButton.disabled = !hasQuote;
      if (target.clearButton) target.clearButton.disabled = !hasQuote;
    }
  }

  function syncQuoteFields(target) {
    if (target.quoteText) target.quoteText.value = selectedQuote.text;
    if (target.quoteStart) target.quoteStart.value = selectedQuote.start;
    if (target.quoteEnd) target.quoteEnd.value = selectedQuote.end;
    if (target.quoteContextBefore) target.quoteContextBefore.value = selectedQuote.contextBefore;
    if (target.quoteContextAfter) target.quoteContextAfter.value = selectedQuote.contextAfter;
  }

  function emptyQuote() {
    return {
      text: "",
      start: "",
      end: "",
      contextBefore: "",
      contextAfter: ""
    };
  }

  function setupConfirmForms() {
    for (const form of document.querySelectorAll("[data-confirm]")) {
      form.addEventListener("submit", (event) => {
        if (!window.confirm(form.dataset.confirm)) {
          event.preventDefault();
        }
      });
    }
  }

  function setupMobilePanels() {
    const menuToggle = document.querySelector("[data-reader-menu-toggle]");
    const menuClose = document.querySelector("[data-reader-menu-close]");
    const overlay = document.querySelector("[data-reader-overlay]");
    const settingsToggle = document.querySelector("[data-reader-settings-toggle]");
    const mobileQuery = window.matchMedia("(max-width: 1024px)");

    const setMenuOpen = (isOpen) => {
      shell.classList.toggle("mobile-nav-open", isOpen);
      document.body.classList.toggle("reader-menu-open", isOpen);
      menuToggle?.setAttribute("aria-expanded", String(isOpen));
    };

    const setSettingsOpen = (isOpen) => {
      shell.classList.toggle("mobile-settings-open", isOpen);
      settingsToggle?.setAttribute("aria-expanded", String(isOpen));
    };

    menuToggle?.addEventListener("click", () => {
      setMenuOpen(!shell.classList.contains("mobile-nav-open"));
    });
    menuClose?.addEventListener("click", () => setMenuOpen(false));
    overlay?.addEventListener("click", () => setMenuOpen(false));
    settingsToggle?.addEventListener("click", () => {
      setSettingsOpen(!shell.classList.contains("mobile-settings-open"));
    });

    for (const link of document.querySelectorAll("[data-reader-sidebar] a")) {
      link.addEventListener("click", () => setMenuOpen(false));
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSettingsOpen(false);
      }
    });

    const handleMobileQueryChange = (event) => {
      if (!event.matches) {
        setMenuOpen(false);
        setSettingsOpen(false);
      }
    };
    if (mobileQuery.addEventListener) {
      mobileQuery.addEventListener("change", handleMobileQueryChange);
    } else {
      mobileQuery.addListener(handleMobileQueryChange);
    }
  }

  function applyPrefs(next) {
    const isVertical = next.orientation === "vertical";
    shell.classList.toggle("vertical", isVertical);
    shell.classList.toggle("horizontal", next.orientation !== "vertical");

    document.documentElement.style.setProperty("--reader-font-size", `${next.fontSize}px`);
    document.documentElement.style.setProperty("--reader-line-height", String(Number(next.lineHeight) / 10));
    document.documentElement.style.setProperty("--paragraph-gap", `${Number(next.paragraphGap) / 10}rem`);

    document.body.classList.remove("theme-light", "theme-sepia", "theme-dark");
    document.body.classList.add(`theme-${next.theme}`);

    if (isVertical) {
      requestAnimationFrame(() => {
        storyBody.scrollLeft = storyBody.scrollWidth;
      });
    }
    scheduleHangingPunctuationFallback();
  }

  function scheduleHangingPunctuationFallback() {
    if (hangingPunctuationFrame) cancelAnimationFrame(hangingPunctuationFrame);
    hangingPunctuationFrame = requestAnimationFrame(applyHangingPunctuationFallback);
  }

  function applyHangingPunctuationFallback() {
    hangingPunctuationFrame = 0;
    if (!storyContent) return;

    for (const node of storyContent.querySelectorAll(".hanging-punctuation-fallback")) {
      node.classList.remove("hanging-punctuation-fallback");
    }

    if (supportsNativeHangingPunctuation || !shell.classList.contains("vertical")) return;

    const nodes = Array.from(storyContent.querySelectorAll("[data-offset]:not([data-newline])"));
    if (nodes.length < 2) return;

    void storyContent.offsetHeight;
    const contentRect = storyContent.getBoundingClientRect();
    const lineStartLimit = contentRect.top + 2;

    for (let index = 1; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!hangingPunctuationPattern.test(node.textContent || "")) continue;

      const previous = nodes[index - 1];
      if (!isAdjacentOffset(previous, node)) continue;

      const rect = node.getBoundingClientRect();
      const previousRect = previous.getBoundingClientRect();
      const isNextColumn = rect.left < previousRect.left - 1;
      const isAtLineStart = rect.top <= lineStartLimit;

      if (isNextColumn && isAtLineStart) {
        node.classList.add("hanging-punctuation-fallback");
        void node.offsetHeight;
      }
    }
  }

  function isAdjacentOffset(previous, current) {
    const previousStart = Number(previous.dataset.offset);
    const previousLength = Number(previous.dataset.length || "1");
    const currentStart = Number(current.dataset.offset);
    return Number.isFinite(previousStart)
      && Number.isFinite(previousLength)
      && Number.isFinite(currentStart)
      && previousStart + previousLength === currentStart;
  }

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  }
})();
