import { useState, useEffect } from "react";

export default function SettingsModal({ open, onClose }) {
  const [geminiKey, setGeminiKey] = useState("");
  const [openalexEmail, setOpenalexEmail] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      setGeminiKey(localStorage.getItem("kol_gemini_key") || "");
      setOpenalexEmail(localStorage.getItem("kol_openalex_email") || "");
      setSaved(false);
    }
  }, [open]);

  function handleSave() {
    localStorage.setItem("kol_gemini_key", geminiKey);
    localStorage.setItem("kol_openalex_email", openalexEmail);
    setSaved(true);
    setTimeout(() => onClose(), 600);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-gray-900 mb-4">Settings</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Gemini API Key
            </label>
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="AIza..."
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-primary focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">
              Free at{" "}
              <a
                href="https://aistudio.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-primary underline"
              >
                aistudio.google.com
              </a>
              . Required for AI profiles.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              OpenAlex Email
            </label>
            <input
              type="email"
              value={openalexEmail}
              onChange={(e) => setOpenalexEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-primary focus:border-transparent"
            />
            <p className="text-xs text-gray-400 mt-1">
              Used for OpenAlex polite pool (faster rate limits).
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-6">
          {saved && (
            <span className="text-sm text-green-600 font-medium">Saved</span>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-teal-primary text-white rounded hover:bg-teal-dark transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
