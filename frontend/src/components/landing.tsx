import { CardTitle, CardDescription, CardHeader, CardContent, Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useState, useEffect, useRef } from "react"
import axios from "axios"

const BACKEND_UPLOAD_URL = "http://localhost:3000";

interface LogMessage {
  log: string;
  type: "stdout" | "stderr" | "info";
  timestamp: string;
  status?: string;
}

export function Landing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [rootDirectory, setRootDirectory] = useState("");
  const [deploymentType, setDeploymentType] = useState("auto");
  const [uploadId, setUploadId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // 1. On Initial Page Mount: Check URL Query Parameter ?id=... or localStorage
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const queryId = urlParams.get("id");
    const savedId = localStorage.getItem("lastDeploymentId");
    
    const activeId = queryId || savedId;
    if (activeId) {
      setUploadId(activeId);
      axios.get(`${BACKEND_UPLOAD_URL}/status?id=${activeId}`)
        .then(res => setStatus(res.data.status))
        .catch(err => console.error("Error fetching initial status:", err));
    }
  }, []);

  // 2. Connect to Pure SSE Stream (Handles BOTH Build Logs AND Status Updates with ZERO Polling!)
  useEffect(() => {
    if (!uploadId) return;

    const newUrl = `${window.location.pathname}?id=${uploadId}`;
    window.history.replaceState({ path: newUrl }, "", newUrl);
    localStorage.setItem("lastDeploymentId", uploadId);

    const sseUrl = `${BACKEND_UPLOAD_URL}/logs?id=${uploadId}`;
    const eventSource = new EventSource(sseUrl);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.log) {
          setLogs((prev) => [...prev, data]);
        }

        if (data.status) {
          setStatus(data.status);
          if (data.status === "deployed" || data.status === "failed") {
            console.log(`[SSE Frontend] Build reached final state '${data.status}'. Closing SSE stream.`);
            eventSource.close();
          }
        }
      } catch (err) {
        console.error("Failed to parse SSE event data:", err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn("SSE connection closed or reconnecting:", err);
    };

    return () => {
      eventSource.close();
    };
  }, [uploadId]);

  // Auto-scroll build log window to bottom
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleDeploy = async () => {
    if (!repoUrl) return;
    setUploading(true);
    setLogs([]);
    try {
      const res = await axios.post(`${BACKEND_UPLOAD_URL}/deploy`, { repoUrl, deploymentType, rootDirectory });
      setUploadId(res.data.id);
      setStatus("uploaded");
    } catch (err: any) {
      alert(err.response?.data?.error || "Failed to trigger deployment.");
    } finally {
      setUploading(false);
    }
  };

  const handleNewDeployment = () => {
    setUploadId("");
    setRepoUrl("");
    setRootDirectory("");
    setStatus("");
    setLogs([]);
    setDeploymentType("auto");
    localStorage.removeItem("lastDeploymentId");
    window.history.replaceState({ path: window.location.pathname }, "", window.location.pathname);
  };

  const deployedUrl = `http://${uploadId}.localhost:3001/index.html`;
  const apiUrl = `http://${uploadId}.localhost:3001/api/`;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader className="flex flex-row justify-between items-start">
          <div>
            <CardTitle className="text-xl">Deploy your GitHub Repository</CardTitle>
            <CardDescription>Enter a GitHub repository or subfolder URL to build and deploy to Edge CDN</CardDescription>
          </div>
          {uploadId && (
            <Button variant="outline" size="sm" onClick={handleNewDeployment}>
              + New Deployment
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="github-url">GitHub Repository URL</Label>
              <Input 
                id="github-url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)} 
                placeholder="https://github.com/username/repo or .../tree/main/frontend" 
                disabled={uploading || !!uploadId}
              />
            </div>

            {/* Optional Monorepo Subfolder Directory */}
            <div className="space-y-2">
              <Label htmlFor="root-directory">Root Directory / Subfolder (Optional)</Label>
              <Input 
                id="root-directory"
                value={rootDirectory}
                onChange={(e) => setRootDirectory(e.target.value)} 
                placeholder="e.g. frontend or backend (leave blank for root)" 
                disabled={uploading || !!uploadId}
              />
            </div>

            {/* Framework / Deployment Preset Selector */}
            <div className="space-y-2">
              <Label htmlFor="framework-preset">Framework / Deployment Preset</Label>
              <select
                id="framework-preset"
                value={deploymentType}
                onChange={(e) => setDeploymentType(e.target.value)}
                disabled={uploading || !!uploadId}
                className="w-full flex h-10 items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-950 dark:text-gray-100 dark:border-gray-800"
              >
                <option value="auto">⚡ Auto-Detect (Smart Inspection)</option>
                <option value="react">⚛️ React / Vite / Vue SPA</option>
                <option value="static">📄 Static HTML / CSS</option>
                <option value="next">⚡ Next.js (Static / SSR)</option>
                <option value="express">🟢 Node.js / Express Serverless Backend</option>
              </select>
            </div>

            <Button 
              onClick={handleDeploy} 
              disabled={!repoUrl || uploading || !!uploadId} 
              className="w-full"
            >
              {uploadId ? `Deploying ID: ${uploadId}` : uploading ? "Uploading Source Files..." : "Deploy Repository"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Terminal Live Build Log Viewer (Pure SSE Stream) */}
      {uploadId && (
        <Card className="w-full max-w-2xl mt-6 border border-gray-800 bg-gray-950 text-gray-100 font-mono shadow-2xl">
          <CardHeader className="border-b border-gray-800 pb-3">
            <div className="flex justify-between items-center">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-green-400">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                Container Build Logs [{uploadId}]
              </CardTitle>
              <span className={`text-xs px-2 py-0.5 rounded font-bold uppercase ${
                status === "deployed" ? "bg-green-900 text-green-300" :
                status === "failed" ? "bg-red-900 text-red-300" :
                status === "building" ? "bg-blue-900 text-blue-300" : "bg-gray-800 text-gray-300"
              }`}>
                {status || "Initializing"}
              </span>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div 
              ref={logContainerRef}
              className="h-64 overflow-y-auto space-y-1 text-xs leading-relaxed p-2 rounded bg-black/50 border border-gray-900"
            >
              {logs.length === 0 ? (
                <div className="text-gray-500 italic">Connecting & replaying SSE build log history...</div>
              ) : (
                logs.map((item, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="text-gray-600 select-none">
                      {item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : ""}
                    </span>
                    <span className={
                      item.type === "stderr" ? "text-red-400" :
                      item.type === "info" ? "text-cyan-400 font-bold" : "text-gray-200"
                    }>
                      {item.log}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Deployment Deployed URL Result */}
      {status === "deployed" && (
        <Card className="w-full max-w-2xl mt-6 border-green-500/50 bg-green-950/20">
          <CardHeader>
            <CardTitle className="text-xl text-green-400">🎉 Deployment Successful!</CardTitle>
            <CardDescription>Your service is live on the Edge CDN with sub-15ms response times.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Live API Endpoint Link */}
            <div className="space-y-2">
              <Label htmlFor="api-url" className="text-emerald-400 font-semibold">Serverless API Endpoint Link</Label>
              <div className="flex gap-2">
                <Input id="api-url" readOnly type="url" value={apiUrl} className="font-mono text-sm border-emerald-800 bg-gray-950 text-emerald-300" />
                <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" asChild>
                  <a href={apiUrl} target="_blank" rel="noopener noreferrer">
                    Open API ⚡
                  </a>
                </Button>
              </div>
            </div>

            {/* Static Website Link */}
            <div className="space-y-2 pt-2 border-t border-gray-800">
              <Label htmlFor="deployed-url" className="text-gray-400">Static Status / Web Link</Label>
              <div className="flex gap-2">
                <Input id="deployed-url" readOnly type="url" value={deployedUrl} className="font-mono text-sm" />
                <Button variant="outline" asChild>
                  <a href={deployedUrl} target="_blank" rel="noopener noreferrer">
                    Visit Site 🌐
                  </a>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
