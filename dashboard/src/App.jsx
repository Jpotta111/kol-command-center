import { useState, useEffect } from "react";
import NetworkGraph from "./components/NetworkGraph";
import KOLTable from "./components/KOLTable";
import CSVImportExport from "./components/CSVImportExport";
import CREDReview from "./components/CREDReview";
import Publications from "./components/Publications";
import Pipeline from "./components/Pipeline";
import SettingsModal from "./components/SettingsModal";
import { sampleGraph, sampleProfiles } from "./sample_data";

const TABS = [
  { id: "graph", label: "Network Graph" },
  { id: "table", label: "KOL Table" },
  { id: "csv", label: "CSV Import/Export" },
  { id: "pipeline", label: "Pipeline" },
  { id: "pubs", label: "Publications" },
  // CRED Review tab — hidden from public UI, available for
  // future password-protected access. Sprint 8b complete.
  // { id: "cred", label: "CRED Review" },
];

function GearIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState("graph");
  const [graphData, setGraphData] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [selectedKOL, setSelectedKOL] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Shared state: pipeline contacts from CSV upload
  const [pipelineContacts, setPipelineContacts] = useState(null);
  const [pipelineUploadDate, setPipelineUploadDate] = useState(null);

  useEffect(() => {
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
        <div className="ml-auto flex items-center gap-4">
          <span className="text-xs text-white/60">
            {graphData.nodes.length} KOLs &middot;{" "}
            {graphData.edges.length} connections
          </span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-white/70 hover:text-white transition-colors p-1 rounded hover:bg-white/10"
            title="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </nav>

      {/* Auth notice */}
      {!localStorage.getItem("kol_gemini_key") && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-800 flex items-center gap-2">
          <span>
            Add your Gemini API key in{" "}
            <button
              onClick={() => setSettingsOpen(true)}
              className="underline font-medium"
            >
              Settings
            </button>{" "}
            to enable AI profile generation. Authentication is not yet
            configured — this app is currently open.
          </span>
        </div>
      )}

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
          <CSVImportExport
            nodes={graphData.nodes}
            onContactsLoaded={(rows) => {
              setPipelineContacts(rows);
              setPipelineUploadDate(new Date().toLocaleDateString());
            }}
          />
        )}
        {tab === "pipeline" && (
          <Pipeline
            contacts={pipelineContacts}
            uploadDate={pipelineUploadDate}
          />
        )}
        {tab === "pubs" && (
          <Publications nodes={graphData.nodes} />
        )}
        {tab === "cred" && (
          <CREDReview />
        )}
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
