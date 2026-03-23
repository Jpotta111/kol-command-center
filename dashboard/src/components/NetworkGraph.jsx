import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import ProfilePanel from "./ProfilePanel";

const TIER_COLORS = { A: "#22c55e", B: "#3b82f6", C: "#eab308", D: "#9ca3af" };

export default function NetworkGraph({ graphData, profiles, selectedKOL, onSelectKOL }) {
  const svgRef = useRef();
  const simRef = useRef();
  const [showEdges, setShowEdges] = useState(true);

  const profile = profiles.find(
    (p) => p._meta?.openalex_id === selectedKOL?.openalex_id
  );

  const handleZoom = useCallback((dir) => {
    const svg = d3.select(svgRef.current);
    const g = svg.select("g.graph-root");
    const currentTransform = d3.zoomTransform(svg.node());
    const newK = dir === "in" ? currentTransform.k * 1.3 : currentTransform.k / 1.3;
    svg.transition().duration(300).call(
      d3.zoom().on("zoom", (e) => g.attr("transform", e.transform)).transform,
      d3.zoomIdentity.translate(currentTransform.x, currentTransform.y).scale(newK)
    );
  }, []);

  const handleReset = useCallback(() => {
    const svg = d3.select(svgRef.current);
    const g = svg.select("g.graph-root");
    svg.transition().duration(500).call(
      d3.zoom().on("zoom", (e) => g.attr("transform", e.transform)).transform,
      d3.zoomIdentity
    );
  }, []);

  useEffect(() => {
    if (!graphData) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const container = svgRef.current.parentElement;
    const width = container.clientWidth;
    const height = container.clientHeight;
    svg.attr("width", width).attr("height", height);

    const g = svg.append("g").attr("class", "graph-root");

    // Zoom behavior
    const zoom = d3.zoom().scaleExtent([0.2, 5]).on("zoom", (e) => {
      g.attr("transform", e.transform);
    });
    svg.call(zoom);

    // Deep copy for D3 mutation
    const nodes = graphData.nodes.map((n) => ({ ...n }));
    const edges = graphData.edges.map((e) => ({
      source: nodes.find((n) => n.openalex_id === (typeof e.source === "string" ? e.source : e.source.openalex_id)) || e.source,
      target: nodes.find((n) => n.openalex_id === (typeof e.target === "string" ? e.target : e.target.openalex_id)) || e.target,
      weight: e.weight || 1,
    })).filter((e) => e.source && e.target);

    // Radius scale
    const rScale = d3.scaleLinear()
      .domain([d3.min(nodes, (n) => n.ops_score) || 0, d3.max(nodes, (n) => n.ops_score) || 100])
      .range([4, 20]);

    // Edge group
    const edgeGroup = g.append("g").attr("class", "edges");
    const link = edgeGroup
      .selectAll("line")
      .data(edges)
      .join("line")
      .attr("stroke", "#d1d5db")
      .attr("stroke-width", (d) => Math.max(1, d.weight))
      .attr("stroke-opacity", 0.6);

    // Node group
    const nodeGroup = g.append("g").attr("class", "nodes");
    const node = nodeGroup
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3.drag()
          .on("start", (e, d) => {
            if (!e.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (e, d) => {
            d.fx = e.x;
            d.fy = e.y;
          })
          .on("end", (e, d) => {
            if (!e.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    node.append("circle")
      .attr("r", (d) => rScale(d.ops_score || 0))
      .attr("fill", (d) => TIER_COLORS[d.tier] || "#9ca3af")
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5);

    node.append("text")
      .text((d) => d.display_name.split(" ").pop())
      .attr("dy", (d) => rScale(d.ops_score || 0) + 12)
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("fill", "#374151")
      .attr("pointer-events", "none");

    // Hover tooltip
    node
      .on("mouseover", function (e, d) {
        d3.select(this).select("circle").attr("stroke", "#00726B").attr("stroke-width", 3);
      })
      .on("mouseout", function (e, d) {
        d3.select(this).select("circle").attr("stroke", "#fff").attr("stroke-width", 1.5);
      })
      .on("click", (e, d) => {
        onSelectKOL(d);
      });

    // Simulation
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(edges).id((d) => d.openalex_id).distance(100))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((d) => rScale(d.ops_score || 0) + 5))
      .on("tick", () => {
        link
          .attr("x1", (d) => d.source.x)
          .attr("y1", (d) => d.source.y)
          .attr("x2", (d) => d.target.x)
          .attr("y2", (d) => d.target.y);
        node.attr("transform", (d) => `translate(${d.x},${d.y})`);
      });

    simRef.current = sim;

    return () => sim.stop();
  }, [graphData, onSelectKOL]);

  // Toggle edge visibility
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.select("g.edges").attr("display", showEdges ? null : "none");
  }, [showEdges]);

  return (
    <div className="flex h-full">
      <div className="flex-1 relative">
        <svg ref={svgRef} className="w-full h-full bg-gray-50" />

        {/* Controls */}
        <div className="absolute top-3 left-3 flex flex-col gap-1">
          <button onClick={() => handleZoom("in")} className="bg-white shadow rounded w-8 h-8 text-sm font-bold text-gray-700 hover:bg-gray-100">+</button>
          <button onClick={() => handleZoom("out")} className="bg-white shadow rounded w-8 h-8 text-sm font-bold text-gray-700 hover:bg-gray-100">&minus;</button>
          <button onClick={handleReset} className="bg-white shadow rounded w-8 h-8 text-[10px] font-semibold text-gray-700 hover:bg-gray-100">RST</button>
          <button
            onClick={() => setShowEdges(!showEdges)}
            className={`bg-white shadow rounded w-8 h-8 text-[10px] font-semibold hover:bg-gray-100 ${showEdges ? "text-teal-primary" : "text-gray-400"}`}
          >
            E
          </button>
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 bg-white/90 shadow rounded px-3 py-2 flex gap-3 text-xs">
          {Object.entries(TIER_COLORS).map(([tier, color]) => (
            <span key={tier} className="flex items-center gap-1">
              <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: color }} />
              Tier {tier}
            </span>
          ))}
        </div>
      </div>

      {/* Profile sidebar */}
      {selectedKOL && (
        <ProfilePanel
          kol={selectedKOL}
          profile={profile}
          onClose={() => onSelectKOL(null)}
        />
      )}
    </div>
  );
}
