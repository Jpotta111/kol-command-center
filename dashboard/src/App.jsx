import { useState, useEffect } from "react";
import NetworkGraph from "./components/NetworkGraph";
import KOLTable from "./components/KOLTable";
import CSVImportExport from "./components/CSVImportExport";
import { sampleGraph, sampleProfiles } from "./sample_data";

const TABS = [
  { id: "graph", label: "Network Graph" },
  { id: "table", label: "KOL Table" },
  { id: "csv", label: "CSV Import/Export" },
];

export default function App() {
  const [tab, setTab] = useState("graph");
  const [graphData, setGraphData] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [selectedKOL, setSelectedKOL] = useState(null);

  useEffect(() => {
    // Try loading real pipeline data, fall back to sample
    Promise.all([
      fetch("/data/kol_graph.json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetch("/data/kol_profiles.json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]).then(([graph, profs]) => {
      setGraphData(graph || sampleGraph);
      setProfiles(profs || sampleProfiles);
    });
  }, []);

  if (!graphData) {
    return (
      <div className="flex items-center justify-center h-screen bg-teal-light">
        <p className="text-teal-primary text-lg">Loading KOL data...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Top nav */}
      <nav className="bg-teal-primary text-white px-6 py-3 flex items-center gap-8 shrink-0">
        <h1 className="text-lg font-bold tracking-tight mr-4">
          KOL Command Center
        </h1>
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-white/20 text-white"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ml-auto text-xs text-white/60">
          {graphData.nodes.length} KOLs &middot;{" "}
          {graphData.edges.length} connections
        </div>
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === "graph" && (
          <NetworkGraph
            graphData={graphData}
            profiles={profiles}
            selectedKOL={selectedKOL}
            onSelectKOL={setSelectedKOL}
          />
        )}
        {tab === "table" && (
          <KOLTable
            nodes={graphData.nodes}
            profiles={profiles}
            onSelectKOL={(kol) => {
              setSelectedKOL(kol);
              setTab("graph");
            }}
          />
        )}
        {tab === "csv" && (
          <CSVImportExport nodes={graphData.nodes} />
        )}
      </div>
    </div>
  );
}
