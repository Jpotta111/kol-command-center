/**
 * Vercel serverless function: Commercial KOL enrichment via Gemini + Google Search.
 *
 * POST /api/commercial-enrich
 * Body: JSON array of commercial contacts
 * Headers: X-Gemini-Key
 *
 * Uses Gemini 2.5 Flash with Google Search grounding to look up
 * current role, organization info, and recent news for each contact.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enrichContact(contact, apiKey) {
  const name = contact.display_name || contact.name ||
    `${contact.firstname || ""} ${contact.lastname || ""}`.trim();
  const company = contact.company || contact.Company ||
    contact.institution || contact.Institution || "";
  const title = contact.job_title || contact.jobtitle || "";

  if (!name) return null;

  const prompt = `Search for information about this person and their organization. Return ONLY valid JSON.

Person: ${name}
Company: ${company}
Known title: ${title}

Find:
1. Their current job title and confirm they still work at ${company || "their organization"}
2. What type of organization is it: Health Plan, Self-Insured Employer, PBM, IDN, or Other
3. Approximate number of covered lives or employees if publicly available
4. Any recent news (last 6 months) about this person being appointed, promoted, or joining a new org
5. Their LinkedIn URL if findable

Respond with ONLY this JSON structure:
{
  "confirmed_title": "their current title or best match",
  "confirmed_organization": "current employer name",
  "org_type": "Health Plan" | "Self-Insured Employer" | "PBM" | "IDN" | "Other",
  "covered_lives": null or number,
  "recent_news": "one sentence summary or empty string",
  "linkedin_url": "URL or empty string",
  "data_confidence": "HIGH" | "MEDIUM" | "LOW"
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
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
    const apiKey = req.headers["x-gemini-key"] || process.env.GEMINI_API_KEY || "";
    if (!apiKey) {
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

    const contacts = Array.isArray(body) ? body : body.contacts || [];
    if (!contacts.length) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No contacts provided." })); return;
    }

    const results = [];

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const name = contact.display_name || contact.name ||
        `${contact.firstname || ""} ${contact.lastname || ""}`.trim();

      try {
        const enriched = await enrichContact(contact, apiKey);
        results.push({
          hs_object_id: contact.hs_object_id || "",
          display_name: name,
          original_company: contact.company || contact.Company || "",
          original_title: contact.job_title || contact.jobtitle || "",
          ...enriched,
        });
      } catch (err) {
        results.push({
          hs_object_id: contact.hs_object_id || "",
          display_name: name,
          original_company: contact.company || contact.Company || "",
          original_title: contact.job_title || contact.jobtitle || "",
          confirmed_title: "",
          confirmed_organization: "",
          org_type: "",
          covered_lives: null,
          recent_news: "",
          linkedin_url: "",
          data_confidence: "LOW",
          error: err.message,
        });
      }

      if (i < contacts.length - 1) await sleep(1500);
    }

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(results));
  } catch (err) {
    console.error("Commercial enrich error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
