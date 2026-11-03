import { Parser } from 'commonmark';

const escapeHTML = (value: string): string => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));

function safeHref(value: string | null): string | null {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

/** Render only known CommonMark nodes. Raw HTML stays text and images never load. */
export function renderReportMarkdown(markdown: string): string {
  const walker = new Parser().parse(markdown).walker();
  const parts: string[] = [];
  let event;
  while ((event = walker.next())) {
    const { node, entering } = event;
    const literal = () => escapeHTML(node.literal ?? '');
    switch (node.type) {
      case 'document': case 'image': break;
      case 'text': case 'html_inline': case 'html_block':
        if (entering) parts.push(literal());
        break;
      case 'code': if (entering) parts.push(`<code>${literal()}</code>`); break;
      case 'code_block': if (entering) parts.push(`<pre><code>${literal()}</code></pre>\n`); break;
      case 'softbreak': if (entering) parts.push('\n'); break;
      case 'linebreak': if (entering) parts.push('<br>\n'); break;
      case 'thematic_break': if (entering) parts.push('<hr>\n'); break;
      case 'heading': {
        const level = Math.min(6, Math.max(1, node.level));
        parts.push(entering ? `<h${level}>` : `</h${level}>\n`);
        break;
      }
      case 'paragraph': parts.push(entering ? '<p>' : '</p>\n'); break;
      case 'block_quote': parts.push(entering ? '<blockquote>' : '</blockquote>\n'); break;
      case 'item': parts.push(entering ? '<li>' : '</li>\n'); break;
      case 'list': {
        const tag = node.listType === 'ordered' ? 'ol' : 'ul';
        const start = tag === 'ol' && Number.isSafeInteger(node.listStart) && node.listStart !== 1 ? ` start="${node.listStart}"` : '';
        parts.push(entering ? `<${tag}${start}>` : `</${tag}>\n`);
        break;
      }
      case 'emph': parts.push(entering ? '<em>' : '</em>'); break;
      case 'strong': parts.push(entering ? '<strong>' : '</strong>'); break;
      case 'link': {
        const href = safeHref(node.destination);
        if (href) parts.push(entering ? `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">` : '</a>');
        break;
      }
    }
  }
  return parts.join('');
}
