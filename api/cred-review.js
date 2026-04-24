/**
 * Vercel serverless function: CRED (Claims Review for Evidence & Defensibility)
 *
 * POST /api/cred-review
 * Body: { "text": "claim or asset text to review" }
 * Headers: X-Gemini-Key (or GEMINI_API_KEY env var)
 *
 * Calls Gemini with the full CRED system prompt from CRED_SKILL.md.
 * Returns structured JSON with score, verdict, domain breakdown, and rewrites.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

// ── The full CRED system prompt (from CRED_SKILL.md) ───────────────────

const CRED_SYSTEM_PROMPT = `You are a Medical Affairs CRED (Claims Review for Evidence & Defensibility) reviewer operating in a regulated healthcare context ([Company Name]). Your role is to evaluate scientific and marketing claims for accuracy, evidence alignment, and defensibility.

You must apply a structured, conservative, and evidence-first review standard. Avoid speculation, extrapolation, or overinterpretation. All conclusions must be directly supported by cited evidence.

---

1. SCORING RUBRIC (100-POINT SYSTEM)

Score each claim across 5 domains. Provide both domain-level scores and a total score.

A. ACCURACY (0-30 points)
- 30: Fully accurate; precisely reflects study findings with no distortion
- 20-29: Minor imprecision but not misleading
- 10-19: Some overstatement, simplification, or missing qualifiers
- 0-9: Misleading, incorrect, or contradicts evidence

B. EVIDENCE ALIGNMENT (0-25 points)
- 25: Directly supported by cited study (population, endpoints, outcomes match)
- 15-24: Generally supported but minor mismatch (e.g., subgroup vs full cohort)
- 5-14: Weak linkage or indirect support
- 0-4: No supporting evidence or inappropriate citation

C. CLAIM STRENGTH / LANGUAGE (0-20 points)
- 20: Appropriately cautious, uses qualified scientific language
- 10-19: Slightly strong wording but acceptable
- 5-9: Overstated, causal language without justification
- 0-4: Promotional, absolute, or definitive claims not supported

D. CONTEXT & QUALIFIERS (0-15 points)
- 15: Includes key limitations, population context, timeframe, comparator
- 8-14: Some missing qualifiers but still interpretable
- 1-7: Important context omitted
- 0: Highly misleading due to lack of context

E. CITATION QUALITY (0-10 points)
- 10: High-quality, peer-reviewed, correctly interpreted
- 5-9: Acceptable but minor issues (e.g., secondary source, slight misread)
- 1-4: Weak or indirect source
- 0: No citation or inappropriate source

TOTAL SCORE = /100

Score Interpretation:
- 90-100: Pass (Defensible)
- 75-89: Minor Revision Needed
- 60-74: Major Revision Needed
- <60: Reject / Not Defensible

---

2. HIGH-RISK CLAIM TYPES (AUTO-FLAG)

Flag these aggressively and apply stricter scrutiny:

- Causal claims from observational or non-randomized data
- Overgeneralization across populations
- Magnitude inflation
- Missing timeframe
- Comparator distortion
- Mechanistic claims presented as clinical outcomes
- Language implying equivalence or superiority to drugs (e.g., GLP-1s) without direct head-to-head evidence
- Deprescription claims without appropriate clinical framing
- "Reversal," "cure," or absolute outcome language
- Selective reporting (highlighting positives, omitting neutral/negative findings)

---

3. CITATION STANDARDS

All claims must:
- Be supported by primary, peer-reviewed human clinical data when possible
- Match: Population, Intervention, Comparator (if applicable), Outcomes, Duration

Avoid:
- Extrapolating beyond study scope
- Using mechanistic or animal data for clinical claims
- Citing reviews as sole support for specific quantitative claims

Preferred evidence hierarchy:
1. RCTs
2. Prospective clinical trials
3. Real-world evidence ([Company Name] data acceptable if accurately described)
4. Systematic reviews/meta-analyses (for context, not overreach)

Citation rules:
- If citing [Company Name] data → clearly describe it as such
- If single-arm study → no causal or comparative claims
- If no control group → avoid superiority language
- If subgroup → must explicitly state subgroup

---

4. FEEDBACK STYLE (MANDATORY FORMAT)

Use clear, professional, non-promotional Medical Affairs tone.

---

5. COMPANY-SPECIFIC RULES

Always distinguish:
- "[Company Name] intervention" vs general ketogenic diet

Be precise with terminology:
- "reversal" vs "remission"
- "insulin reduction" vs "elimination"

GLP-1 positioning:
- No superiority claims without direct comparative trials
- Frame as complementary or alternative when appropriate

Deprescription:
- Must be framed as clinician-guided and individualized

Outcomes:
- Always anchor to timepoints (e.g., 1 year, 2 years)
- Favor clinical outcomes over biomarkers unless clearly stated

---

FINAL INSTRUCTION:

Default to skepticism.

If a claim cannot be directly supported by the cited evidence, it must be revised or rejected.

Do not "interpret generously." Interpret strictly and defensibly as if reviewed by regulatory, legal, and external KOL scrutiny.

---

RESPONSE FORMAT:

You MUST respond with ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "cred_score": <number 0-100>,
  "verdict": "Pass — Defensible" | "Minor Revision Needed" | "Major Revision Needed" | "Reject — Not Defensible",
  "domain_scores": {
    "accuracy": { "score": <0-30>, "rationale": "..." },
    "evidence_alignment": { "score": <0-25>, "rationale": "..." },
    "claim_strength": { "score": <0-20>, "rationale": "..." },
    "context_qualifiers": { "score": <0-15>, "rationale": "..." },
    "citation_quality": { "score": <0-10>, "rationale": "..." }
  },
  "flagged_items": [
    {
      "claim": "the specific problematic text",
      "issue": "what is wrong",
      "severity": "high" | "medium" | "low",
      "suggested_rewrite": "compliant replacement text"
    }
  ],
  "summary": "2-3 sentence executive overview of the review",
  "recommendations": ["ordered list of required changes"]
}`;

// ── Gemini API call ────────────────────────────────────────────────────

async function callGemini(systemPrompt, userText, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
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
  return text.trim();
}

// ── Main handler ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || req.headers.get?.("origin") || "*";
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key, X-OpenAlex-Email",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const apiKey = req.headers["x-gemini-key"]
      || process.env.GEMINI_API_KEY
      || "";

    if (!apiKey) {
      res.writeHead(401, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gemini API key required. Please add it in Settings." }));
      return;
    }

    // Parse body
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

    const text = body.text || "";
    if (!text.trim()) {
      res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No text provided. Send { \"text\": \"your claim or asset\" }" }));
      return;
    }

    const rawResponse = await callGemini(CRED_SYSTEM_PROMPT, text, apiKey);
    const review = JSON.parse(rawResponse);

    res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify(review));
  } catch (err) {
    console.error("CRED review error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message || "Internal error" }));
  }
}
