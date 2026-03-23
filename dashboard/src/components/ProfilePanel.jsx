import { useEffect, useRef } from "react";
import * as d3 from "d3";

const TIER_COLORS = { A: "#22c55e", B: "#3b82f6", C: "#eab308", D: "#9ca3af" };

const DIMENSIONS = [
  { key: "scientific_influence_score", label: "Scientific" },
  { key: "clinical_alignment_score", label: "Alignment" },
  { key: "reach_visibility_score", label: "Reach" },
  { key: "nutrition_openness_score", label: "Nutrition" },
  { key: "strategic_value_score", label: "Strategic" },
];

function BarChart({ kol }) {
  const ref = useRef();

  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();

    const w = 240, h = 120, margin = { top: 4, right: 8, bottom: 20, left: 60 };
    const innerW = w - margin.left - margin.right;
    const innerH = h - margin.top - margin.bottom;

    const g = svg
      .attr("width", w)
      .attr("height", h)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    const y = d3.scaleBand().domain(DIMENSIONS.map(d => d.label)).range([0, innerH]).padding(0.25);
    const x = d3.scaleLinear().domain([0, 20]).range([0, innerW]);

    g.selectAll("rect")
      .data(DIMENSIONS)
      .join("rect")
      .attr("y", d => y(d.label))
      .attr("x", 0)
      .attr("width", d => x(kol[d.key] || 0))
      .attr("height", y.bandwidth())
      .attr("fill", TIER_COLORS[kol.tier] || "#9ca3af")
      .attr("rx", 2);

    g.selectAll(".val")
      .data(DIMENSIONS)
      .join("text")
      .attr("class", "val")
      .attr("y", d => y(d.label) + y.bandwidth() / 2)
      .attr("x", d => x(kol[d.key] || 0) + 4)
      .attr("dy", "0.35em")
      .attr("font-size", "9px")
      .attr("fill", "#374151")
      .text(d => (kol[d.key] || 0).toFixed(1));

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(4).tickSize(3))
      .selectAll("text").attr("font-size", "8px");

    g.append("g")
      .call(d3.axisLeft(y).tickSize(0))
      .selectAll("text").attr("font-size", "9px");

    g.selectAll(".domain").attr("stroke", "#d1d5db");
  }, [kol]);

  return <svg ref={ref} />;
}

export default function ProfilePanel({ kol, profile, onClose }) {
  if (!kol) return null;

  const stance = profile?.nutrition_stance_assessment;
  const stanceLevel = typeof stance === "object" ? stance?.level : stance;
  const stanceReason = typeof stance === "object" ? stance?.reasoning : null;

  return (
    <div className="w-80 bg-white border-l border-gray-200 overflow-y-auto p-4 flex flex-col gap-3 shadow-lg">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-bold text-base text-gray-900">{kol.display_name}</h2>
          <p className="text-xs text-gray-500">{kol.institution || "—"}</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
      </div>

      {/* Score badge */}
      <div className="flex items-center gap-3">
        <span
          className="inline-flex items-center justify-center w-12 h-12 rounded-full text-white font-bold text-lg"
          style={{ backgroundColor: TIER_COLORS[kol.tier] || "#9ca3af" }}
        >
          {kol.tier}
        </span>
        <div>
          <p className="text-2xl font-bold text-gray-900">{kol.ops_score?.toFixed(1)}</p>
          <p className="text-xs text-gray-500">OPS Score / 100</p>
        </div>
      </div>

      {/* Bar chart */}
      <div>
        <p className="text-xs font-semibold text-gray-600 mb-1">Subdimension Scores</p>
        <BarChart kol={kol} />
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-50 rounded p-2">
          <span className="text-gray-500">h-index</span>
          <p className="font-semibold">{kol.h_index}</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <span className="text-gray-500">Citations</span>
          <p className="font-semibold">{kol.citation_count?.toLocaleString()}</p>
        </div>
      </div>

      {/* Profile fields (from Gemini) */}
      {profile && !profile._error && (
        <>
          {profile.summary && (
            <Section title="Summary">{profile.summary}</Section>
          )}

          {stanceLevel && (
            <Section title="Nutrition Stance">
              <StanceBadge level={stanceLevel} />
              {stanceReason && <p className="mt-1 text-xs text-gray-600">{stanceReason}</p>}
            </Section>
          )}

          {profile.outreach_angle && (
            <Section title="Outreach Angle">{profile.outreach_angle}</Section>
          )}

          {profile.sme_briefing && (
            <Section title="SME Briefing">{profile.sme_briefing}</Section>
          )}

          {profile.key_papers?.length > 0 && (
            <Section title="Key Papers">
              <ul className="space-y-1.5">
                {profile.key_papers.map((p, i) => (
                  <li key={i}>
                    <p className="text-xs font-medium text-gray-800">{p.title}</p>
                    <p className="text-xs text-gray-500">{p.relevance}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {profile.red_flags?.length > 0 && (
            <Section title="Red Flags">
              <ul className="list-disc list-inside text-xs text-red-600">
                {profile.red_flags.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            </Section>
          )}
        </>
      )}

      {(!profile || profile._error) && (
        <p className="text-xs text-gray-400 italic">
          No Gemini profile available. Run: python -m intelligence.profile_generator
        </p>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p className="text-xs font-semibold text-teal-primary mb-0.5">{title}</p>
      <div className="text-xs text-gray-700 leading-relaxed">{children}</div>
    </div>
  );
}

function StanceBadge({ level }) {
  const colors = {
    HIGH: "bg-green-100 text-green-800",
    MEDIUM: "bg-yellow-100 text-yellow-800",
    LOW: "bg-red-100 text-red-800",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${colors[level] || "bg-gray-100 text-gray-600"}`}>
      {level}
    </span>
  );
}
