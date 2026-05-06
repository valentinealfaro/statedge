import { useState } from 'react';

// Copies the current page URL to the clipboard. Compare.tsx keeps the URL
// in sync with the matchup, so this just mirrors what the user is looking at.
// Free-tier-allowed — sharing is good for distribution.
export function ShareButton() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older Safari / iframe contexts: fall back to the textarea trick.
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* nothing else we can do */
      } finally {
        ta.remove();
      }
    }
  }

  return (
    <button className={copied ? 'share-btn copied' : 'share-btn'} onClick={copy}>
      {copied ? 'Link copied ✓' : 'Copy link'}
    </button>
  );
}
