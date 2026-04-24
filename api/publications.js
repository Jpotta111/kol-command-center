/**
 * Vercel serverless function: Publication monitor + check-in list.
 *
 * POST /api/publications
 * Body: JSON array of KOL objects (display_name, email, kol_tier, institution)
 * Headers: X-Gemini-Key, X-OpenAlex-Email
 *
 * Queries PubMed for each KOL's publications in the last 30 days.
 * For KOLs with new papers, generates a brief check-in email via Gemini.
 * Returns only KOLs who published recently, sorted by tier then date.
 */

const PUBMED_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const GEMINI_MODEL = "gemini-2.5-flash";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// ── PubMed: recent publications ────────────────────────────────────────

async function fetchRecentPubs(name, daysBack = 30) {
  const today = new Date();
  const minDate = new Date(today);
  minDate.setDate(minDate.getDate() - daysBack);

  const params = new URLSearchParams({
    db: "pubmed",
    term: `${name}[Author]`,
    mindate: formatDate(minDate),
    maxdate: formatDate(today),
    datetype: "pdat",
    retmax: "3",
    retmode: "json",
  });

  const resp = await fetch(`${PUBMED_BASE}/esearch.fcgi?${params}`);
  if (!resp.ok) return [];

  const data = await resp.json();
  const idlist = data?.esearchresult?.idlist || [];
  if (!idlist.length) return [];

  await sleep(400);

  // Fetch paper details
  const fetchParams = new URLSearchParams({
    db: "pubmed",
    id: idlist.join(","),
    retmode: "xml",
  });
  const fetchResp = await fetch(`${PUBMED_BASE}/efetch.fcgi?${fetchParams}`);
  if (!fetchResp.ok) return [];

  const xml = await fetchResp.text();

  // Extract titles and dates from XML
  const papers = [];
  const articleRe = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRe.exec(xml)) !== null) {
    const article = match[1];
    const titleMatch = article.match(/<ArticleTitle>([^<]+)<\/ArticleTitle>/);
    const yearMatch = article.match(/<PubDate>[\s\S]*?<Year>(\d+)<\/Year>/);
    const monthMatch = article.match(/<PubDate>[\s\S]*?<Month>([^<]+)<\/Month>/);
    const dayMatch = article.match(/<PubDate>[\s\S]*?<Day>(\d+)<\/Day>/);

    if (titleMatch) {
      const year = yearMatch ? yearMatch[1] : "";
      const month = monthMatch ? monthMatch[1] : "";
      const day = dayMatch ? dayMatch[1] : "";
      papers.push({
        title: titleMatch[1],
        date: [year, month, day].filter(Boolean).join(" "),
      });
    }
  }

  return papers;
}

// ── Gemini: generate check-in email ────────────────────────────────────

async function generateCheckInEmail(kol, paperTitle, apiKey) {
  const prompt = `Write a 2-3 sentence peer-to-peer email from a Medical Affairs Manager at [Company Name] (nutrition-first T2D reversal) to ${kol.display_name} at ${kol.institution || "their institution"}. They just published: "${paperTitle}". The tone should be: genuine, collegial, brief. Not sales. Just acknowledging their work and leaving a door open. Sign off as Jared Potter, Medical Affairs, [Company Name].

Respond with ONLY valid JSON (no markdown):
{"subject_line": "...", "email_body": "..."}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gemini ${resp.status}: ${err?.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(text.trim());
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.get?.("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key, X-OpenAlex-Email",
  };

  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }
  if (req.method !== "POST") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" })); return;
  }

  try {
    const geminiKey = req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY || "";
    if (!geminiKey) {
      res.writeHead(401, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gemini API key required. Please add it in Settings." }));
      return;
    }

    let body;
    if (typeof req.body === "object" && req.body !== null) {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      }
      body = JSON.parse(chunks.join(""));
    }

    const kols = Array.isArray(body) ? body : body.kols || [];
    if (!kols.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No KOLs provided." })); return;
    }

    const results = [];

    for (const kol of kols) {
      const name = kol.display_name || "";
      if (!name) continue;

      const papers = await fetchRecentPubs(name);
      await sleep(400);

      if (!papers.length) continue;

      // Generate email for the most recent paper
      const paper = papers[0];
      try {
        const email = await generateCheckInEmail(kol, paper.title, geminiKey);
        await sleep(1500); // Gemini rate limit

        results.push({
          display_name: name,
          email: kol.email || "",
          kol_tier: kol.kol_tier || kol.tier || "",
          institution: kol.institution || "",
          paper_title: paper.title,
          paper_date: paper.date,
          subject_line: email.subject_line || "",
          email_body: email.email_body || "",
        });
      } catch (err) {
        // Still include the KOL but without email draft
        results.push({
          display_name: name,
          email: kol.email || "",
          kol_tier: kol.kol_tier || kol.tier || "",
          institution: kol.institution || "",
          paper_title: paper.title,
          paper_date: paper.date,
          subject_line: "",
          email_body: `(Email generation failed: ${err.message})`,
        });
      }
    }

    // Sort: A tier first, then by date (newest first)
    const tierOrder = { A: 0, B: 1, C: 2, D: 3 };
    results.sort((a, b) => {
      const ta = tierOrder[a.kol_tier] ?? 4;
      const tb = tierOrder[b.kol_tier] ?? 4;
      if (ta !== tb) return ta - tb;
      return (b.paper_date || "").localeCompare(a.paper_date || "");
    });

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
  } catch (err) {
    console.error("Publications error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
