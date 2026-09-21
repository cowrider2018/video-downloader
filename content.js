// Reports <video>/<audio> sources found in the page. The network listener in the
// background catches most media; this covers files served from cache and sources
// that were set before the extension started watching.
(() => {
  const seen = new Set();

  function report(urls) {
    const fresh = urls.filter((u) => u && /^https?:/i.test(u) && !seen.has(u));
    if (!fresh.length) return;
    fresh.forEach((u) => seen.add(u));
    try {
      chrome.runtime.sendMessage({ type: 'dom-media', urls: fresh }).catch(() => {});
    } catch {
      // Extension was reloaded; this orphaned script can no longer talk to it.
    }
  }

  function scan() {
    const urls = [];
    for (const el of document.querySelectorAll('video, audio')) {
      urls.push(el.currentSrc, el.src);
      for (const s of el.querySelectorAll('source')) urls.push(s.src);
    }
    report(urls);
  }

  // Media events do not bubble, but they can be caught in the capture phase.
  document.addEventListener(
    'loadstart',
    (e) => {
      if (e.target instanceof HTMLMediaElement) report([e.target.currentSrc || e.target.src]);
    },
    true,
  );

  scan();

  // The document shown directly inside the viewer window names the downloads.
  if (window !== window.top && window.parent === window.top) {
    let last = null;
    const sendTitle = () => {
      if (document.title === last) return;
      last = document.title;
      try {
        chrome.runtime.sendMessage({ type: 'page-title', title: last }).catch(() => {});
      } catch {
        // Extension was reloaded.
      }
    };
    sendTitle();
    new MutationObserver(sendTitle).observe(document.head || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
})();
