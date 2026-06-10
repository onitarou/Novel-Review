(() => {
  const txtImport = document.querySelector("[data-txt-import]");
  const previewGap = document.querySelector("[data-preview-gap]");
  const storyPreview = document.querySelector("[data-story-preview]");

  setupConfirmForms();
  if (txtImport) setupTxtImport(txtImport);
  if (previewGap && storyPreview) setupPreviewGap(previewGap, storyPreview);

  function setupConfirmForms() {
    for (const form of document.querySelectorAll("[data-confirm]")) {
      form.addEventListener("submit", (event) => {
        if (!window.confirm(form.dataset.confirm)) {
          event.preventDefault();
        }
      });
    }
  }

  function setupTxtImport(root) {
    const fileInput = root.querySelector("[data-txt-file]");
    const info = root.querySelector("[data-txt-info]");
    const preview = root.querySelector("[data-txt-preview]");
    const applyButton = root.querySelector("[data-apply-txt]");
    const clearButton = root.querySelector("[data-clear-txt]");
    const bodyInput = document.querySelector("[data-story-body-input]");
    const defaultInfo = info.textContent;

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) {
        clearPreview();
        return;
      }

      try {
        const buffer = await file.arrayBuffer();
        const decoded = decodeText(buffer);
        preview.value = decoded.text;
        info.textContent = `${file.name} / ${decoded.encoding} / ${decoded.text.length}文字`;
        applyButton.disabled = decoded.text.length === 0;
        clearButton.disabled = false;
      } catch (error) {
        clearPreview();
        info.textContent = `読み込みに失敗しました: ${error.message}`;
      }
    });

    applyButton.addEventListener("click", () => {
      if (!preview.value) return;
      bodyInput.value = preview.value;
      bodyInput.dispatchEvent(new Event("input", { bubbles: true }));
      info.textContent = "プレビュー内容を本文へ反映しました。保存または公開を実行してください。";
    });

    clearButton.addEventListener("click", () => {
      fileInput.value = "";
      clearPreview();
    });

    function clearPreview() {
      preview.value = "";
      info.textContent = defaultInfo;
      applyButton.disabled = true;
      clearButton.disabled = true;
    }
  }

  function setupPreviewGap(control, preview) {
    const applyGap = () => {
      preview.style.setProperty("--paragraph-gap", `${Number(control.value) / 10}rem`);
    };

    control.addEventListener("input", applyGap);
    applyGap();
  }

  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);

    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        encoding: "UTF-8"
      };
    } catch {
      // Fall through to Shift_JIS for Japanese txt files created by older editors.
    }

    try {
      return {
        text: new TextDecoder("shift_jis", { fatal: true }).decode(bytes),
        encoding: "Shift_JIS"
      };
    } catch {
      return {
        text: new TextDecoder("utf-8").decode(bytes),
        encoding: "UTF-8 replacement"
      };
    }
  }
})();
