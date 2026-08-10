// BM25 retrieval over the MCP tool catalogue.
//
// The full tool catalogue is ~18K tokens of JSON, which does not fit alongside a
// conversation in a Q4 7-8B model's usable context. Each turn we score the user's
// message against the tools and hand the model only the top few.
//
// Indexing uses the complete docstring (rich in synonyms: "MOT", "B&B", "A&E"),
// but `toOpenAITools` emits only the first paragraph, since the rest is CLI usage
// examples that cost context without helping the model choose.

const STOPWORDS = new Set(
  ("a an and are as at be by for from get has have how i in is it its me my of on or "
  + "please show tell that the this to was what when where which who will with you your "
  + "data statistics stats give find latest current number numbers info information " +
    "default optional example examples returns args source note notes")
    .split(/\s+/),
);

const K1 = 1.5;
const B = 0.75;

// Docstrings are written for CLI users; chat users reach for different words.
// These hints bridge the gap for tools where the two vocabularies barely overlap.
const HINTS = {
  check_availability: "free busy calendar meeting call chat schedule book slot time diary",
  send_contact_message: "contact email reach message get in touch hire enquiry",
  get_recent_blog_posts: "blog wrote writing article post recently",
  bolster_nisra_feed: "published publication release announcement new update recently",
  bolster_psni_rtc: "killed died death crash accident collision injured cyclist pedestrian",
  bolster_dva: "mot test vehicle driving licence theory practical",
};

const DOUBLED = /([bdgmnprt])\1$/;

// Deliberately smaller than Porter: plurals plus -ing/-ed/-ly is enough to unify
// the query/docstring pairs that matter, and every extra rule risks collapsing
// two distinct NISRA tools onto the same stem.
function stem(token) {
  let t = token;
  if (t.length > 3 && t.endsWith("ies")) t = t.slice(0, -3) + "y";
  else if (t.length > 3 && t.endsWith("s") && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);

  for (const suffix of ["ing", "ed", "ly"]) {
    if (t.length - suffix.length >= 3 && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }

  return DOUBLED.test(t) ? t.slice(0, -1) : t;
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}

function termFrequencies(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export function buildIndex(tools) {
  const docs = tools.map((tool) => {
    // The name carries real signal ("nisra_cancer_waiting_times") and repeating it
    // weights an exact name mention above an incidental prose match.
    const nameTokens = tokenize(tool.name.replace(/_/g, " "));
    const tokens = [
      ...nameTokens,
      ...nameTokens,
      ...tokenize(tool.description),
      ...tokenize(Object.keys(tool.inputSchema?.properties ?? {}).join(" ")),
      ...tokenize(HINTS[tool.name] ?? ""),
    ];
    return { tool, tf: termFrequencies(tokens), length: tokens.length };
  });

  const docFreq = new Map();
  for (const doc of docs) {
    for (const term of doc.tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  const avgLength = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1);
  return { docs, docFreq, avgLength, total: docs.length };
}

function idf(index, term) {
  const n = index.docFreq.get(term) ?? 0;
  if (n === 0) return 0;
  return Math.log(1 + (index.total - n + 0.5) / (n + 0.5));
}

export function search(index, query, limit = 6) {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return [];

  const scored = index.docs.map((doc) => {
    let score = 0;
    for (const term of queryTerms) {
      const freq = doc.tf.get(term);
      if (!freq) continue;
      const norm = freq * (K1 + 1);
      const denom = freq + K1 * (1 - B + (B * doc.length) / index.avgLength);
      score += idf(index, term) * (norm / denom);
    }
    return { tool: doc.tool, score };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
}

export function summarize(description) {
  return String(description).split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
}

export function toOpenAITools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: summarize(tool.description),
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}
