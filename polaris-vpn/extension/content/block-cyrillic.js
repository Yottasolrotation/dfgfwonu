// Keeps Cyrillic text out of every field on the pages listed in manifest.json.
(() => {
  const CYRILLIC = /\p{Script=Cyrillic}/u;
  const CYRILLIC_RUNS = /\p{Script=Cyrillic}+/gu;

  let toast = null;
  let hideTimer = 0;

  function notify() {
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('role', 'status');
      toast.textContent = 'Russian input is blocked here. Switch your keyboard layout.';
      toast.style.cssText =
        'all:initial;position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
        'padding:8px 14px;border-radius:8px;background:#1f2430;color:#fff;font:13px/1.4 system-ui,sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:nowrap;pointer-events:none';
    }
    document.documentElement.append(toast);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => toast.remove(), 2500);
  }

  function block(event) {
    event.preventDefault();
    // Rich editors insert text from their own handlers, so they must not see the event at all.
    event.stopImmediatePropagation();
    notify();
  }

  // Capture on window at document_start so these run before the page's listeners.
  addEventListener(
    'beforeinput',
    (event) => {
      const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
      if (event.cancelable && CYRILLIC.test(text)) block(event);
    },
    true,
  );

  for (const type of ['paste', 'drop']) {
    addEventListener(
      type,
      (event) => {
        const data = event.clipboardData ?? event.dataTransfer;
        if (CYRILLIC.test(data?.getData('text/plain') ?? '')) block(event);
      },
      true,
    );
  }

  // Composition and dictation cannot be cancelled, so plain fields are cleaned afterwards.
  addEventListener(
    'input',
    (event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
      if (!CYRILLIC.test(field.value)) return;
      const caret = field.selectionStart;
      const kept = caret == null ? null : field.value.slice(0, caret).replace(CYRILLIC_RUNS, '').length;
      field.value = field.value.replace(CYRILLIC_RUNS, '');
      if (kept != null) field.setSelectionRange(kept, kept);
      notify();
    },
    true,
  );
})();
