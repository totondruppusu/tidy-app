import { getExtension } from "./files";

export type CodeLanguage =
  | "c"
  | "clojure"
  | "config"
  | "cpp"
  | "css"
  | "docker"
  | "generic"
  | "go"
  | "graphql"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "lua"
  | "make"
  | "perl"
  | "php"
  | "powershell"
  | "python"
  | "ruby"
  | "rust"
  | "shell"
  | "sql"
  | "swift"
  | "typescript"
  | "xml"
  | "yaml";

export type TextPreviewDescriptor = {
  kind: "code" | "plain";
  language: CodeLanguage;
  label: string;
};

type DescriptorTemplate = Omit<TextPreviewDescriptor, "kind"> & {
  kind?: TextPreviewDescriptor["kind"];
};

const PLAIN_TEXT_EXTENSIONS: Record<string, DescriptorTemplate> = {
  csv: { language: "generic", label: "CSV", kind: "plain" },
  log: { language: "generic", label: "Log", kind: "plain" },
  txt: { language: "generic", label: "Text", kind: "plain" },
  tsv: { language: "generic", label: "TSV", kind: "plain" },
};

const CODE_EXTENSIONS: Record<string, DescriptorTemplate> = {
  astro: { language: "html", label: "Astro" },
  bash: { language: "shell", label: "Bash" },
  bat: { language: "powershell", label: "Batch" },
  c: { language: "c", label: "C" },
  cc: { language: "cpp", label: "C++" },
  cjs: { language: "javascript", label: "JavaScript" },
  clj: { language: "clojure", label: "Clojure" },
  cljs: { language: "clojure", label: "Clojure" },
  cmd: { language: "powershell", label: "Batch" },
  cmake: { language: "config", label: "CMake" },
  conf: { language: "config", label: "Config" },
  cpp: { language: "cpp", label: "C++" },
  cs: { language: "generic", label: "C#" },
  css: { language: "css", label: "CSS" },
  cts: { language: "typescript", label: "TypeScript" },
  cxx: { language: "cpp", label: "C++" },
  dart: { language: "generic", label: "Dart" },
  edn: { language: "clojure", label: "EDN" },
  env: { language: "config", label: "Dotenv" },
  fish: { language: "shell", label: "Fish" },
  go: { language: "go", label: "Go" },
  gql: { language: "graphql", label: "GraphQL" },
  graphql: { language: "graphql", label: "GraphQL" },
  groovy: { language: "generic", label: "Groovy" },
  h: { language: "c", label: "C Header" },
  hh: { language: "cpp", label: "C++ Header" },
  hpp: { language: "cpp", label: "C++ Header" },
  htm: { language: "html", label: "HTML" },
  html: { language: "html", label: "HTML" },
  hxx: { language: "cpp", label: "C++ Header" },
  ini: { language: "config", label: "INI" },
  java: { language: "java", label: "Java" },
  js: { language: "javascript", label: "JavaScript" },
  json: { language: "json", label: "JSON" },
  jsx: { language: "javascript", label: "JSX" },
  kt: { language: "kotlin", label: "Kotlin" },
  kts: { language: "kotlin", label: "Kotlin" },
  less: { language: "css", label: "Less" },
  lua: { language: "lua", label: "Lua" },
  m: { language: "generic", label: "Objective-C" },
  markdown: { language: "generic", label: "Markdown", kind: "plain" },
  md: { language: "generic", label: "Markdown", kind: "plain" },
  mjs: { language: "javascript", label: "JavaScript" },
  mm: { language: "generic", label: "Objective-C++" },
  mts: { language: "typescript", label: "TypeScript" },
  php: { language: "php", label: "PHP" },
  pl: { language: "perl", label: "Perl" },
  pm: { language: "perl", label: "Perl" },
  properties: { language: "config", label: "Properties" },
  ps1: { language: "powershell", label: "PowerShell" },
  psd1: { language: "powershell", label: "PowerShell" },
  psm1: { language: "powershell", label: "PowerShell" },
  py: { language: "python", label: "Python" },
  r: { language: "generic", label: "R" },
  rb: { language: "ruby", label: "Ruby" },
  rs: { language: "rust", label: "Rust" },
  sass: { language: "css", label: "Sass" },
  scala: { language: "generic", label: "Scala" },
  scss: { language: "css", label: "SCSS" },
  sh: { language: "shell", label: "Shell" },
  sql: { language: "sql", label: "SQL" },
  svelte: { language: "html", label: "Svelte" },
  swift: { language: "swift", label: "Swift" },
  toml: { language: "config", label: "TOML" },
  ts: { language: "typescript", label: "TypeScript" },
  tsx: { language: "typescript", label: "TSX" },
  vue: { language: "html", label: "Vue" },
  xml: { language: "xml", label: "XML" },
  yaml: { language: "yaml", label: "YAML" },
  yml: { language: "yaml", label: "YAML" },
  zsh: { language: "shell", label: "Zsh" },
};

const SPECIAL_FILENAMES: Record<string, DescriptorTemplate> = {
  ".bash_profile": { language: "shell", label: "Shell" },
  ".bashrc": { language: "shell", label: "Shell" },
  ".editorconfig": { language: "config", label: "EditorConfig" },
  ".eslintrc": { language: "json", label: "ESLint" },
  ".gitattributes": { language: "config", label: "Git attributes" },
  ".gitignore": { language: "config", label: "Git ignore" },
  ".gitmodules": { language: "config", label: "Git modules" },
  ".npmrc": { language: "config", label: "npmrc" },
  ".prettierrc": { language: "json", label: "Prettier" },
  ".profile": { language: "shell", label: "Shell" },
  ".stylelintrc": { language: "json", label: "Stylelint" },
  ".yarnrc": { language: "config", label: "yarnrc" },
  ".zshrc": { language: "shell", label: "Shell" },
  "cmakelists.txt": { language: "config", label: "CMake" },
  "dockerfile": { language: "docker", label: "Dockerfile" },
  "gemfile": { language: "ruby", label: "Ruby" },
  "gnumakefile": { language: "make", label: "Makefile" },
  "justfile": { language: "make", label: "Justfile" },
  "makefile": { language: "make", label: "Makefile" },
  "procfile": { language: "config", label: "Procfile" },
  "rakefile": { language: "ruby", label: "Ruby" },
};

const SPECIAL_PREFIXES: Array<{
  prefix: string;
  descriptor: DescriptorTemplate;
}> = [
  { prefix: ".env", descriptor: { language: "config", label: "Dotenv" } },
  { prefix: ".babelrc", descriptor: { language: "json", label: "Babel" } },
  { prefix: ".eslintrc.", descriptor: { language: "json", label: "ESLint" } },
  { prefix: ".prettierrc.", descriptor: { language: "json", label: "Prettier" } },
  { prefix: ".stylelintrc.", descriptor: { language: "json", label: "Stylelint" } },
];

const DEFAULT_PLAIN_DESCRIPTOR: TextPreviewDescriptor = {
  kind: "plain",
  language: "generic",
  label: "Text",
};

const KEYWORDS: Partial<Record<CodeLanguage, string[]>> = {
  c: [
    "auto",
    "break",
    "case",
    "const",
    "continue",
    "default",
    "do",
    "else",
    "enum",
    "extern",
    "for",
    "goto",
    "if",
    "inline",
    "register",
    "return",
    "sizeof",
    "static",
    "struct",
    "switch",
    "typedef",
    "union",
    "volatile",
    "while",
  ],
  clojure: [
    "def",
    "defn",
    "fn",
    "if",
    "let",
    "loop",
    "ns",
    "quote",
    "recur",
    "when",
  ],
  config: ["include", "set"],
  cpp: [
    "class",
    "const",
    "constexpr",
    "delete",
    "else",
    "enum",
    "explicit",
    "for",
    "friend",
    "if",
    "namespace",
    "new",
    "noexcept",
    "nullptr",
    "operator",
    "private",
    "protected",
    "public",
    "return",
    "struct",
    "switch",
    "template",
    "this",
    "throw",
    "try",
    "typename",
    "using",
    "virtual",
    "while",
  ],
  docker: [
    "ADD",
    "ARG",
    "CMD",
    "COPY",
    "ENTRYPOINT",
    "ENV",
    "EXPOSE",
    "FROM",
    "HEALTHCHECK",
    "LABEL",
    "ONBUILD",
    "RUN",
    "SHELL",
    "STOPSIGNAL",
    "USER",
    "VOLUME",
    "WORKDIR",
  ],
  generic: [
    "as",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "def",
    "else",
    "enum",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "import",
    "in",
    "interface",
    "let",
    "match",
    "new",
    "null",
    "return",
    "static",
    "struct",
    "switch",
    "this",
    "throw",
    "trait",
    "true",
    "try",
    "type",
    "undefined",
    "use",
    "var",
    "while",
  ],
  go: [
    "break",
    "case",
    "chan",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "fallthrough",
    "for",
    "func",
    "go",
    "if",
    "import",
    "interface",
    "map",
    "package",
    "range",
    "return",
    "select",
    "struct",
    "switch",
    "type",
    "var",
  ],
  graphql: ["enum", "extend", "fragment", "implements", "input", "interface", "mutation", "on", "query", "scalar", "schema", "subscription", "type", "union"],
  java: [
    "abstract",
    "break",
    "case",
    "catch",
    "class",
    "continue",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "for",
    "if",
    "implements",
    "import",
    "interface",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "static",
    "switch",
    "this",
    "throw",
    "throws",
    "try",
    "while",
  ],
  javascript: [
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "default",
    "delete",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "of",
    "return",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "yield",
  ],
  json: [],
  kotlin: [
    "as",
    "break",
    "class",
    "companion",
    "continue",
    "data",
    "else",
    "for",
    "fun",
    "if",
    "import",
    "interface",
    "internal",
    "is",
    "null",
    "object",
    "override",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "sealed",
    "suspend",
    "this",
    "typealias",
    "val",
    "var",
    "when",
    "while",
  ],
  lua: ["and", "break", "do", "else", "elseif", "end", "for", "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "until", "while"],
  make: ["define", "else", "endif", "export", "if", "ifdef", "ifndef", "ifeq", "ifneq", "include", "override", "private", "undefine", "unexport", "vpath"],
  perl: ["else", "elsif", "for", "foreach", "if", "last", "my", "next", "our", "package", "return", "sub", "unless", "use", "while"],
  php: ["abstract", "class", "const", "echo", "else", "elseif", "extends", "final", "fn", "foreach", "function", "if", "implements", "interface", "namespace", "new", "private", "protected", "public", "return", "static", "trait", "use", "while"],
  powershell: ["begin", "break", "catch", "class", "continue", "do", "else", "elseif", "end", "filter", "finally", "for", "foreach", "function", "if", "in", "param", "process", "return", "switch", "throw", "trap", "try", "until", "while"],
  python: ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "elif", "else", "except", "False", "finally", "for", "from", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"],
  ruby: ["BEGIN", "END", "alias", "begin", "break", "case", "class", "def", "do", "else", "elsif", "end", "ensure", "for", "if", "in", "module", "next", "redo", "rescue", "retry", "return", "self", "super", "then", "undef", "unless", "until", "when", "while", "yield"],
  rust: ["as", "async", "await", "break", "const", "continue", "crate", "else", "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "trait", "type", "unsafe", "use", "where", "while"],
  shell: ["case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local", "readonly", "return", "select", "then", "time", "until", "while"],
  sql: ["and", "as", "between", "by", "create", "delete", "drop", "from", "group", "having", "inner", "insert", "into", "join", "left", "limit", "not", "null", "on", "or", "order", "outer", "select", "set", "table", "update", "values", "where"],
  swift: ["actor", "associatedtype", "break", "case", "class", "continue", "default", "defer", "do", "else", "enum", "extension", "fallthrough", "for", "func", "guard", "if", "import", "in", "init", "let", "mutating", "private", "protocol", "public", "return", "struct", "switch", "throw", "throws", "try", "var", "where", "while"],
  typescript: [
    "abstract",
    "as",
    "asserts",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "declare",
    "default",
    "else",
    "enum",
    "export",
    "extends",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "infer",
    "instanceof",
    "interface",
    "keyof",
    "let",
    "namespace",
    "new",
    "of",
    "override",
    "private",
    "protected",
    "public",
    "readonly",
    "return",
    "satisfies",
    "static",
    "switch",
    "this",
    "throw",
    "try",
    "type",
    "typeof",
    "var",
    "while",
  ],
  yaml: [],
};

const LITERALS = /\b(?:false|true|null|undefined|None|nil)\b/g;
const NUMBERS = /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b/g;
const TOKEN_PREFIX = "__CODE_TOKEN_";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const wrapToken = (className: string, value: string) =>
  `<span class="${className}">${value}</span>`;

const restoreTokens = (value: string, tokens: string[]) =>
  tokens.reduce(
    (result, tokenHtml, index) =>
      result.split(`${TOKEN_PREFIX}${index}__`).join(tokenHtml),
    value,
  );

const protectTokens = (
  input: string,
  patterns: Array<{ className: string; pattern: RegExp }>,
) => {
  const tokens: string[] = [];
  let value = input;
  for (const { className, pattern } of patterns) {
    value = value.replace(pattern, (match) => {
      const token = `${TOKEN_PREFIX}${tokens.length}__`;
      tokens.push(wrapToken(className, escapeHtml(match)));
      return token;
    });
  }
  return { tokens, value };
};

const highlightKeywordSet = (value: string, language: CodeLanguage) => {
  const keywords = KEYWORDS[language];
  if (!keywords || keywords.length === 0) {
    return value;
  }
  const pattern = new RegExp(`\\b(?:${keywords.join("|")})\\b`, "g");
  return value.replace(pattern, (match) => wrapToken("token-keyword", match));
};

const highlightGenericLine = (
  line: string,
  language: CodeLanguage,
  commentPatterns: RegExp[],
  variablePatterns: RegExp[] = [],
) => {
  const { tokens, value } = protectTokens(line, [
    ...commentPatterns.map((pattern) => ({ className: "token-comment", pattern })),
    {
      className: "token-string",
      pattern: /(["'`])(?:\\.|(?!\1).)*\1/g,
    },
  ]);
  let html = escapeHtml(value);
  for (const pattern of variablePatterns) {
    html = html.replace(pattern, (match) => wrapToken("token-variable", match));
  }
  html = highlightKeywordSet(html, language);
  html = html.replace(LITERALS, (match) => wrapToken("token-literal", match));
  html = html.replace(NUMBERS, (match) => wrapToken("token-number", match));
  return restoreTokens(html, tokens);
};

const highlightConfigLine = (line: string) => {
  const { tokens, value } = protectTokens(line, [
    { className: "token-comment", pattern: /[#;].*$/g },
    {
      className: "token-string",
      pattern: /(["'])(?:\\.|(?!\1).)*\1/g,
    },
  ]);
  let html = escapeHtml(value);
  html = html.replace(
    /^(\s*)([\w.-]+)(\s*[:=])/,
    (_match, start: string, key: string, separator: string) =>
      `${start}${wrapToken("token-property", key)}${separator}`,
  );
  html = html.replace(
    /^\s*(\[[^[\]]+\])\s*$/,
    (match) => wrapToken("token-keyword", match.trim()),
  );
  html = html.replace(
    /(\$[A-Za-z_][\w]*|\$\{[^}]+\})/g,
    (match) => wrapToken("token-variable", match),
  );
  html = html.replace(LITERALS, (match) => wrapToken("token-literal", match));
  html = html.replace(NUMBERS, (match) => wrapToken("token-number", match));
  return restoreTokens(html, tokens);
};

const highlightMarkupLine = (line: string, language: CodeLanguage) => {
  const { tokens, value } = protectTokens(line, [
    {
      className: "token-comment",
      pattern: language === "xml" ? /<!--.*?(?:-->|$)/g : /<!--.*?(?:-->|$)/g,
    },
    {
      className: "token-string",
      pattern: /(["'])(?:\\.|(?!\1).)*\1/g,
    },
  ]);
  let html = escapeHtml(value);
  html = html.replace(
    /(&lt;\/?)([A-Za-z][\w:-]*)/g,
    (_match, start: string, tag: string) => `${start}${wrapToken("token-tag", tag)}`,
  );
  html = html.replace(
    /(\s)([A-Za-z_:][\w:.-]*)(=)/g,
    (_match, start: string, attr: string, equals: string) =>
      `${start}${wrapToken("token-property", attr)}${equals}`,
  );
  return restoreTokens(html, tokens);
};

const highlightCssLine = (line: string) => {
  const { tokens, value } = protectTokens(line, [
    { className: "token-comment", pattern: /\/\*.*?(?:\*\/|$)/g },
    {
      className: "token-string",
      pattern: /(["'])(?:\\.|(?!\1).)*\1/g,
    },
  ]);
  let html = escapeHtml(value);
  html = html.replace(/@[\w-]+/g, (match) => wrapToken("token-keyword", match));
  html = html.replace(
    /^(\s*)([\w-]+)(\s*:)/,
    (_match, start: string, property: string, separator: string) =>
      `${start}${wrapToken("token-property", property)}${separator}`,
  );
  html = html.replace(NUMBERS, (match) => wrapToken("token-number", match));
  return restoreTokens(html, tokens);
};

const highlightJsonLine = (line: string) => {
  const { tokens, value } = protectTokens(line, [
    {
      className: "token-string",
      pattern: /"(?:\\.|[^"\\])*"/g,
    },
  ]);
  let html = escapeHtml(value);
  html = html.replace(
    /^(\\s*)/,
    (match) => match,
  );
  html = html.replace(
    /(__CODE_TOKEN_\d+__)(\s*:)/g,
    (_match, token: string, separator: string) =>
      `${wrapToken("token-property", token)}${separator}`,
  );
  html = html.replace(LITERALS, (match) => wrapToken("token-literal", match));
  html = html.replace(NUMBERS, (match) => wrapToken("token-number", match));
  return restoreTokens(html, tokens);
};

const highlightYamlLine = (line: string) => {
  const { tokens, value } = protectTokens(line, [
    { className: "token-comment", pattern: /#.*$/g },
    {
      className: "token-string",
      pattern: /(["'])(?:\\.|(?!\1).)*\1/g,
    },
  ]);
  let html = escapeHtml(value);
  html = html.replace(
    /^(\s*-?\s*)([\w.-]+)(\s*:)/,
    (_match, start: string, key: string, separator: string) =>
      `${start}${wrapToken("token-property", key)}${separator}`,
  );
  html = html.replace(LITERALS, (match) => wrapToken("token-literal", match));
  html = html.replace(NUMBERS, (match) => wrapToken("token-number", match));
  return restoreTokens(html, tokens);
};

const highlightSqlLine = (line: string) =>
  highlightGenericLine(line, "sql", [/--.*$/g, /\/\*.*?(?:\*\/|$)/g]);

const highlightShellLine = (line: string) =>
  highlightGenericLine(line, "shell", [/#.*$/g], [/\$[A-Za-z_][\w]*/g, /\$\{[^}]+\}/g]);

const highlightMakeLine = (line: string) =>
  highlightGenericLine(line, "make", [/#.*$/g], [/\$\([^)]+\)/g, /\$\{[^}]+\}/g]);

const highlightDockerLine = (line: string) =>
  highlightGenericLine(line, "docker", [/#.*$/g], [/\$[A-Za-z_][\w]*/g, /\$\{[^}]+\}/g]);

const highlightPowerShellLine = (line: string) =>
  highlightGenericLine(line, "powershell", [/#.*$/g], [/\$[A-Za-z_][\w:]*/g]);

export const getTextPreviewDescriptor = (fileName: string): TextPreviewDescriptor => {
  const normalizedName = fileName.trim().toLowerCase();
  if (SPECIAL_FILENAMES[normalizedName]) {
    const descriptor = SPECIAL_FILENAMES[normalizedName];
    return {
      kind: descriptor.kind ?? "code",
      language: descriptor.language,
      label: descriptor.label,
    };
  }

  const extension = getExtension(fileName);
  if (PLAIN_TEXT_EXTENSIONS[extension]) {
    const descriptor = PLAIN_TEXT_EXTENSIONS[extension];
    return {
      kind: "plain",
      language: descriptor.language,
      label: descriptor.label,
    };
  }

  if (CODE_EXTENSIONS[extension]) {
    const descriptor = CODE_EXTENSIONS[extension];
    return {
      kind: descriptor.kind ?? "code",
      language: descriptor.language,
      label: descriptor.label,
    };
  }

  const prefixDescriptor = SPECIAL_PREFIXES.find(({ prefix }) =>
    normalizedName.startsWith(prefix),
  );
  if (prefixDescriptor) {
    return {
      kind: prefixDescriptor.descriptor.kind ?? "code",
      language: prefixDescriptor.descriptor.language,
      label: prefixDescriptor.descriptor.label,
    };
  }

  return DEFAULT_PLAIN_DESCRIPTOR;
};

export const isSupportedTextPreviewFile = (fileName: string) => {
  const normalizedName = fileName.trim().toLowerCase();
  if (SPECIAL_FILENAMES[normalizedName]) {
    return true;
  }
  const extension = getExtension(fileName);
  if (PLAIN_TEXT_EXTENSIONS[extension] || CODE_EXTENSIONS[extension]) {
    return true;
  }
  return SPECIAL_PREFIXES.some(({ prefix }) => normalizedName.startsWith(prefix));
};

export const highlightCodeLine = (line: string, language: CodeLanguage) => {
  switch (language) {
    case "config":
      return highlightConfigLine(line);
    case "css":
      return highlightCssLine(line);
    case "docker":
      return highlightDockerLine(line);
    case "graphql":
      return highlightGenericLine(line, "graphql", [/#.*$/g]);
    case "html":
      return highlightMarkupLine(line, "html");
    case "json":
      return highlightJsonLine(line);
    case "make":
      return highlightMakeLine(line);
    case "powershell":
      return highlightPowerShellLine(line);
    case "shell":
      return highlightShellLine(line);
    case "sql":
      return highlightSqlLine(line);
    case "xml":
      return highlightMarkupLine(line, "xml");
    case "yaml":
      return highlightYamlLine(line);
    case "javascript":
    case "typescript":
    case "java":
    case "kotlin":
    case "php":
    case "swift":
    case "go":
    case "rust":
    case "c":
    case "cpp":
    case "python":
    case "ruby":
    case "perl":
    case "lua":
    case "clojure":
    case "generic":
      return highlightGenericLine(
        line,
        language,
        language === "python" || language === "ruby" || language === "perl" || language === "clojure"
          ? [/#.*$/g]
          : [/\/\/.*$/g, /\/\*.*?(?:\*\/|$)/g],
      );
    default:
      return escapeHtml(line);
  }
};
