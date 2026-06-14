const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sanitizeHref = (href: string) => {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) {
    return escapeHtml(trimmed);
  }
  return null;
};

const renderInlineMarkdown = (value: string) => {
  const codeTokens: string[] = [];
  let html = escapeHtml(value).replace(
    /`([^`]+)`/g,
    (_match: string, code: string) => {
      const token = `__CODE_TOKEN_${codeTokens.length}__`;
      codeTokens.push(`<code>${code}</code>`);
      return token;
    },
  );

  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match: string, label: string, href: string) => {
      const safeHref = sanitizeHref(href);
      if (!safeHref) {
        return label;
      }
      return `<a href="${safeHref}" target="_blank" rel="noreferrer">${label}</a>`;
    },
  );
  html = html.replace(/(\*\*|__)(.*?)\1/g, "<strong>$2</strong>");
  html = html.replace(/(^|[^\*])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_(?!\s)([^_]+?)_(?!_)/g, "$1<em>$2</em>");

  return codeTokens.reduce(
    (result, tokenHtml, index) =>
      result.replace(`__CODE_TOKEN_${index}__`, tokenHtml),
    html,
  );
};

const wrapList = (items: string[], ordered: boolean) => {
  const tag = ordered ? "ol" : "ul";
  const body = items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("");
  return `<${tag}>${body}</${tag}>`;
};

export const isMarkdownExtension = (extension: string) =>
  MARKDOWN_EXTENSIONS.has(extension);

export const renderMarkdownToHtml = (markdown: string) => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  const paragraphLines: string[] = [];
  const quoteLines: string[] = [];
  const listItems: string[] = [];
  let isOrderedList = false;
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push(
      `<p>${paragraphLines.map((line) => renderInlineMarkdown(line)).join("<br />")}</p>`,
    );
    paragraphLines.length = 0;
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) {
      return;
    }
    blocks.push(
      `<blockquote><p>${quoteLines
        .map((line) => renderInlineMarkdown(line))
        .join("<br />")}</p></blockquote>`,
    );
    quoteLines.length = 0;
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }
    blocks.push(wrapList(listItems, isOrderedList));
    listItems.length = 0;
  };

  const flushCodeBlock = () => {
    if (!inCodeBlock) {
      return;
    }
    const languageClass = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
    blocks.push(
      `<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    );
    inCodeBlock = false;
    codeLanguage = "";
    codeLines = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        flushParagraph();
        flushQuote();
        flushList();
        inCodeBlock = true;
        codeLanguage = fenceMatch[1] ?? "";
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushQuote();
      flushList();
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushQuote();
      flushList();
      blocks.push("<hr />");
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushQuote();
      flushList();
      const level = headingMatch[1].length;
      blocks.push(
        `<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`,
      );
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quoteLines.push(quoteMatch[1]);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      flushQuote();
      if (listItems.length > 0 && !isOrderedList) {
        flushList();
      }
      isOrderedList = true;
      listItems.push(orderedMatch[1]);
      continue;
    }

    const unorderedMatch = line.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      flushQuote();
      if (listItems.length > 0 && isOrderedList) {
        flushList();
      }
      isOrderedList = false;
      listItems.push(unorderedMatch[1]);
      continue;
    }

    flushQuote();
    flushList();
    paragraphLines.push(line.trim());
  }

  flushParagraph();
  flushQuote();
  flushList();
  flushCodeBlock();

  if (blocks.length === 0) {
    return "<p></p>";
  }

  return blocks.join("");
};
